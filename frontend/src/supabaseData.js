import { supabase } from './supabaseClient';

const recordSelection = 'id, employee_id, snack_id, quantity, taken_at, break_type, unit_price, employee:employees!fk_record_employee(name), snack:snacks!fk_record_snack(name)';

function ensureClient() {
  if (!supabase) throw new Error('Supabase is not configured. Set the VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY values in frontend/.env.local, then restart Vite.');
  return supabase;
}

function unwrap({ data, error }, action = 'Supabase request failed') {
  if (error) {
    if (error.code === 'PGRST202') {
      throw new Error('Permanent delete functions are not installed in this Supabase project. Run database/permanent_delete_functions.sql in this project’s SQL Editor, then retry.');
    }
    if (error.code === '42501' || error.code === 'PGRST301') {
      throw new Error('Supabase denied this action. Check that you are signed in and the Row Level Security policies are installed.');
    }
    throw new Error(error.message || action);
  }
  return data;
}

function parseBody(opts) {
  if (!opts?.body) return {};
  return typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
}

function entityDto(row) {
  return row && { id: row.id, name: row.name, active: row.active, createdAt: row.created_at, unitPrice: row.unit_price ?? null };
}

function recordDto(row) {
  if (!row) return row;
  const employee = Array.isArray(row.employee) ? row.employee[0] : row.employee;
  const snack = Array.isArray(row.snack) ? row.snack[0] : row.snack;
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: employee?.name || '',
    snackId: row.snack_id,
    snackName: snack?.name || '',
    quantity: row.quantity,
    breakType: row.break_type ?? null,
    unitPrice: row.unit_price == null ? null : Number(row.unit_price),
    amount: row.unit_price == null ? null : Number(row.unit_price) * Number(row.quantity),
    takenAt: row.taken_at,
  };
}

const noSnacksMissing = 'No Snacks is not installed in this Supabase project. Run database/migrations/2026-11-25-no-snacks-days.sql in the SQL Editor, then reload.';
const noSnacksNeedsBreak = 'No Snacks needs the break-time update. Run database/migrations/2026-11-26-no-snacks-break-type.sql in the SQL Editor, then reload.';
const noSnacksEditMissing = 'Editing No Snacks is not installed in this Supabase project. Run database/migrations/2026-11-27-no-snacks-edit.sql in the SQL Editor, then reload.';
const noSnacksAdminMissing = 'Editing No Snacks as an admin is not installed in this Supabase project. Run database/migrations/2026-11-28-no-snacks-admin-edit.sql in the SQL Editor, then reload.';
const noSnackSelection = 'id, employee_id, day, break_type, created_at, employee:employees(name)';

function noSnackDto(row) {
  const employee = Array.isArray(row.employee) ? row.employee[0] : row.employee;
  return { id: `ns-${row.id}`, noSnacks: true, employeeId: row.employee_id, employeeName: employee?.name || '', snackName: 'No Snacks', quantity: null, breakType: row.break_type, unitPrice: null, amount: null, day: row.day, takenAt: row.created_at };
}

function kolkataStart(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - 330 * 60 * 1000).toISOString();
}

function nextDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

async function getRecords(params) {
  const client = ensureClient();
  let query = client.from('snack_records').select(recordSelection).order('taken_at', { ascending: false }).order('id', { ascending: false });
  if (params.has('date')) {
    const date = params.get('date');
    query = query.gte('taken_at', kolkataStart(date)).lt('taken_at', kolkataStart(nextDate(date)));
  } else {
    if (params.has('from')) query = query.gte('taken_at', kolkataStart(params.get('from')));
    if (params.has('to')) query = query.lt('taken_at', kolkataStart(nextDate(params.get('to'))));
  }
  if (params.has('employeeId')) query = query.eq('employee_id', Number(params.get('employeeId')));
  if (params.has('snackId')) query = query.eq('snack_id', Number(params.get('snackId')));
  if (params.get('breakType') === 'UNASSIGNED') query = query.is('break_type', null);
  else if (params.has('breakType')) query = query.eq('break_type', params.get('breakType'));
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = unwrap(await query.range(offset, offset + pageSize - 1), 'Could not load snack records');
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.map(recordDto);
}

function summarize(rows, key, nameKey) {
  const totals = new Map();
  for (const row of rows) {
    const id = row[key];
    const current = totals.get(id) || { id, name: row[nameKey], quantity: 0, records: 0 };
    current.quantity += Number(row.quantity);
    current.records += 1;
    totals.set(id, current);
  }
  return [...totals.values()].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
}

function summarizeBreak(rows, breakType = null) {
  const selected = breakType ? rows.filter(row => row.breakType === breakType) : rows;
  return {
    snackCount: new Set(selected.map(row => (breakType ? row.snackId : `${row.breakType ?? 'UNASSIGNED'}:${row.snackId}`))).size,
    totalQuantity: selected.reduce((sum, row) => sum + Number(row.quantity), 0),
    recordCount: selected.length,
    totalAmount: selected.reduce((sum, row) => sum + (row.amount ?? 0), 0),
    unpricedRecords: selected.filter(row => row.unitPrice == null).length,
  };
}

async function countRows(table, activeOnly = false) {
  let query = ensureClient().from(table).select('id', { count: 'exact', head: true });
  if (activeOnly) query = query.eq('active', true);
  const { count, error } = await query;
  if (error) unwrap({ error });
  return count || 0;
}

async function entityRequest(table, method, id, body) {
  const client = ensureClient();
  if (method === 'GET') {
    let query = client.from(table).select(table === 'snacks' ? 'id,name,active,created_at,unit_price' : 'id,name,active,created_at');
    query = id ? query.eq('id', Number(id)).single() : query.order('name');
    const data = unwrap(await query, `Could not load ${table}`);
    return Array.isArray(data) ? data.map(entityDto) : entityDto(data);
  }
  if (method === 'POST') {
    const values = { name: body.name.trim(), active: body.active !== false };
    if (table === 'snacks') values.unit_price = body.unitPrice ?? null;
    return entityDto(unwrap(await client.from(table).insert(values).select(table === 'snacks' ? 'id,name,active,created_at,unit_price' : 'id,name,active,created_at').single()));
  }
  if (method === 'PUT') {
    const values = { name: body.name.trim(), active: body.active };
    if (table === 'snacks' && Object.hasOwn(body, 'unitPrice')) values.unit_price = body.unitPrice;
    return entityDto(unwrap(await client.from(table).update(values).eq('id', Number(id)).select(table === 'snacks' ? 'id,name,active,created_at,unit_price' : 'id,name,active,created_at').single()));
  }
  if (method === 'DELETE') {
    const isEmployee = table === 'employees';
    const rpcName = isEmployee ? 'delete_employee_permanently' : 'delete_snack_permanently';
    const rpcArg = isEmployee ? 'target_employee_id' : 'target_snack_id';
    const historyDeleted = unwrap(await client.rpc(rpcName, { [rpcArg]: Number(id) }));
    const count = Number(historyDeleted) || 0;
    const item = isEmployee ? 'Employee' : 'Snack';
    const history = isEmployee ? 'snack history record' : 'history record';
    return {
      deleted: true,
      message: count
        ? `${item} and ${count} ${history}${count === 1 ? '' : 's'} permanently deleted.`
        : `${item} permanently deleted.`,
    };
  }
  throw new Error(`Unsupported ${method} request for ${table}.`);
}

// ---- User management (ADMIN only; enforced by the database and the admin-users Edge Function) ----

export async function listUsers() {
  const result = await ensureClient().rpc('admin_list_users');
  if (result.error?.code === 'PGRST202') {
    throw new Error('User management is not installed. Run database/migrations/2026-11-23-two-role-user-management.sql in the Supabase SQL Editor.');
  }
  return unwrap(result, 'Could not load users');
}

export async function adminUsers(action, payload = {}) {
  const { data, error } = await ensureClient().functions.invoke('admin-users', { body: { action, ...payload } });
  if (error) {
    let message = 'The user management service could not be reached.';
    const status = error.context?.status;
    if (status === 404) message = 'The admin-users Edge Function is not deployed in this Supabase project.';
    else if (error.context?.json) {
      try { message = (await error.context.json()).error || message; } catch { /* keep default */ }
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function completePasswordChange() {
  unwrap(await ensureClient().rpc('complete_password_change'));
}

export async function api(path, opts = {}) {
  const client = ensureClient();
  const request = new URL(path, window.location.origin);
  const pathname = request.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
  const method = (opts.method || 'GET').toUpperCase();
  const body = parseBody(opts);
  const parts = pathname.split('/').filter(Boolean);

  if (parts[0] === 'employees') return entityRequest('employees', method, parts[1], body);
  if (parts[0] === 'snacks') return entityRequest('snacks', method, parts[1], body);

  if (parts[0] === 'me' && method === 'GET') {
    const { data: { user }, error } = await client.auth.getUser();
    if (error) unwrap({ error });
    const { data: profile, error: profileError } = await client.from('user_profiles').select('role,employee_id').eq('user_id', user.id).single();
    if (profileError) unwrap({ error: profileError });
    if (profile.role === 'admin') return null;
    const row = unwrap(await client.from('employees').select('id,name,active,created_at').eq('id', profile.employee_id).single());
    return entityDto(row);
  }

  // Explicit "No Snacks" days (own rows only, enforced by RLS). Never touches snacks / snack_records.
  if (parts[0] === 'no-snacks' && parts.length === 1 && method === 'GET') {
    const p = request.searchParams;
    let query = client.from('no_snack_days').select(noSnackSelection).order('day', { ascending: false }).order('id', { ascending: false });
    if (p.has('date')) query = query.eq('day', p.get('date'));
    else { if (p.has('from')) query = query.gte('day', p.get('from')); if (p.has('to')) query = query.lte('day', p.get('to')); }
    const { data, error } = await query;
    if (error && ['PGRST205', '42P01'].includes(error.code)) throw new Error(noSnacksMissing);
    if (error && ['42703', 'PGRST204'].includes(error.code)) throw new Error(noSnacksNeedsBreak);
    return unwrap({ data, error }, 'Could not load No Snacks records').map(noSnackDto);
  }
  if (parts[0] === 'no-snacks' && parts.length === 1 && method === 'POST') {
    const { data, error } = await client.from('no_snack_days').insert({ employee_id: body.employeeId, break_type: body.breakType }).select(noSnackSelection).single();
    if (error && ['PGRST205', '42P01'].includes(error.code)) throw new Error(noSnacksMissing);
    if (error && ['42703', 'PGRST204'].includes(error.code)) throw new Error(noSnacksNeedsBreak);
    if (error && error.code === '42501' && /office_no_snacks_insert_guard/.test(error.message || '')) throw new Error('Supabase denied this No Snacks entry. Users can submit only for themselves; admins need database/migrations/2026-11-29-no-snacks-admin-submit.sql run in the SQL Editor.');
    if (error && /uk_no_snack_employee_day/.test(error.message || '')) throw new Error('You have already submitted No Snacks for this break today.');
    return noSnackDto(unwrap({ data, error }, 'Could not save No Snacks'));
  }

  // ADMIN: change a No Snacks record's employee / date / break. The database enforces admin-only, duplicates and snack conflicts.
  if (parts[0] === 'no-snacks' && parts[1] && method === 'PUT' && !Object.hasOwn(body, 'snackId')) {
    const id = Number(String(parts[1]).replace(/^ns-/, ''));
    const { data, error } = await client.from('no_snack_days').update({ employee_id: body.employeeId, day: body.day, break_type: body.breakType }).eq('id', id).select(noSnackSelection).maybeSingle();
    if (error && error.code === '42501' && /permission denied for table/.test(error.message || '')) throw new Error(noSnacksAdminMissing);
    if (error && /uk_no_snack_employee_day_break/.test(error.message || '')) throw new Error('A No Snacks record for that employee, date and break already exists.');
    const row = unwrap({ data, error }, 'Could not update the No Snacks record');
    if (!row) throw new Error('This No Snacks record could not be updated. Only an admin can edit it, or it no longer exists.');
    return noSnackDto(row);
  }
  // ADMIN: delete exactly one No Snacks record (the database allows DELETE for admins only).
  if (parts[0] === 'no-snacks' && parts[1] && method === 'DELETE') {
    const deleted = unwrap(await client.from('no_snack_days').delete().eq('id', Number(String(parts[1]).replace(/^ns-/, ''))).select('id'), 'Could not delete the No Snacks record');
    if (!deleted?.length) throw new Error('No No Snacks record was deleted. Only an admin can delete it, or it no longer exists.');
    return null;
  }
  // Turn a No Snacks record into a normal snack record in ONE database transaction (RPC); nothing is changed unless it all succeeds.
  if (parts[0] === 'no-snacks' && parts[1] && method === 'PUT') {
    const result = await client.rpc('convert_no_snacks_to_snack', { p_no_snack_id: Number(String(parts[1]).replace(/^ns-/, '')), p_snack_id: Number(body.snackId), p_quantity: Number(body.quantity) });
    if (result.error && ['PGRST202', '42883'].includes(result.error.code)) throw new Error(noSnacksEditMissing);
    const newId = unwrap(result, 'Could not update No Snacks');
    return recordDto(unwrap(await client.from('snack_records').select(recordSelection).eq('id', newId).single()));
  }

  if (parts[0] === 'records' && parts.length === 1 && method === 'GET') return getRecords(request.searchParams);
  if (parts[0] === 'records' && parts.length === 1 && method === 'POST') {
    const snack = unwrap(await client.from('snacks').select('unit_price').eq('id', Number(body.snackId)).single());
    const row = unwrap(await client.from('snack_records').insert({ employee_id: body.employeeId, snack_id: body.snackId, quantity: body.quantity, break_type: body.breakType, unit_price: snack.unit_price }).select(recordSelection).single());
    return recordDto(row);
  }
  if (parts[0] === 'records' && parts[1] === 'batch' && method === 'POST') {
    const prices = unwrap(await client.from('snacks').select('id,unit_price').in('id', body.items.map(item => Number(item.snackId))));
    const priceBySnack = new Map(prices.map(item => [Number(item.id), item.unit_price]));
    const rows = body.items.map(item => ({ employee_id: body.employeeId, snack_id: item.snackId, quantity: item.quantity, break_type: body.breakType, unit_price: priceBySnack.get(Number(item.snackId)) ?? null }));
    return unwrap(await client.from('snack_records').insert(rows).select(recordSelection)).map(recordDto);
  }
  if (parts[0] === 'records' && parts[1] && method === 'GET') {
    const row = unwrap(await client.from('snack_records').select(recordSelection).eq('id', Number(parts[1])).single());
    return recordDto(row);
  }
  if (parts[0] === 'records' && parts[1] && method === 'PUT') {
    const current = unwrap(await client.from('snack_records').select('snack_id,break_type,unit_price').eq('id', Number(parts[1])).single());
    let unitPrice = current.unit_price;
    if (Number(current.snack_id) !== Number(body.snackId) || unitPrice == null) unitPrice = unwrap(await client.from('snacks').select('unit_price').eq('id', Number(body.snackId)).single()).unit_price;
    const breakType = Object.prototype.hasOwnProperty.call(body, 'breakType') ? body.breakType : current.break_type;
    const row = unwrap(await client.from('snack_records').update({ employee_id: body.employeeId, snack_id: body.snackId, quantity: body.quantity, break_type: breakType, unit_price: unitPrice }).eq('id', Number(parts[1])).select(recordSelection).maybeSingle());
    if (!row) throw new Error('This snack record could not be updated. You can only edit your own records.');
    return recordDto(row);
  }
  if (parts[0] === 'records' && parts[1] && method === 'DELETE') {
    const deleted = unwrap(await client.from('snack_records').delete().eq('id', Number(parts[1])).select('id'));
    if (!deleted?.length) throw new Error('No snack record was deleted. Check that you are signed in with an authorized account and the Supabase delete policy is installed.');
    return null;
  }

  if (parts[0] === 'dashboard' && parts[1] === 'summary') {
    const date = request.searchParams.get('date') || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const [employees, activeEmployees, activeSnacks, records] = await Promise.all([
      countRows('employees'), countRows('employees', true), countRows('snacks', true), getRecords(new URLSearchParams({ date })),
    ]);
    return { employeeCount: employees, activeEmployeeCount: activeEmployees, activeSnackCount: activeSnacks, todayRecordCount: records.length, todayQuantity: records.reduce((sum, record) => sum + record.quantity, 0), morningBreak: summarizeBreak(records, 'MORNING'), eveningBreak: summarizeBreak(records, 'EVENING'), combinedBreak: summarizeBreak(records) };
  }
  if (parts[0] === 'dashboard' && (parts[1] === 'employee-summary' || parts[1] === 'snack-summary')) {
    const date = request.searchParams.get('date') || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const rows = await getRecords(new URLSearchParams({ date }));
    return parts[1] === 'employee-summary' ? summarize(rows, 'employeeId', 'employeeName') : summarize(rows, 'snackId', 'snackName');
  }
  if (parts[0] === 'reports') {
    let params = new URLSearchParams();
    if (parts[1] === 'daily') params.set('date', request.searchParams.get('date'));
    else if (parts[1] === 'weekly') { params.set('from', request.searchParams.get('from')); params.set('to', request.searchParams.get('to')); }
    else if (parts[1] === 'monthly') {
      const year = Number(request.searchParams.get('year'));
      const month = Number(request.searchParams.get('month'));
      params.set('from', `${year}-${String(month).padStart(2, '0')}-01`);
      params.set('to', `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`);
    }
    if (request.searchParams.has('breakType')) params.set('breakType', request.searchParams.get('breakType'));
    const rows = await getRecords(params);
    const employees = summarize(rows, 'employeeId', 'employeeName');
    const snacks = summarize(rows, 'snackId', 'snackName');
    return { totalRecords: rows.length, totalQuantity: rows.reduce((sum, row) => sum + row.quantity, 0), employees, snacks };
  }
  throw new Error(`Unsupported Supabase request: ${method} ${pathname}`);
}
