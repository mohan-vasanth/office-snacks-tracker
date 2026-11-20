import { supabase } from './supabaseClient';

const recordSelection = 'id, employee_id, snack_id, quantity, taken_at, employee:employees!fk_record_employee(name), snack:snacks!fk_record_snack(name)';

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
  return row && { id: row.id, name: row.name, active: row.active, createdAt: row.created_at };
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
    takenAt: row.taken_at,
  };
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
  let query = client.from('snack_records').select(recordSelection).order('taken_at', { ascending: false });
  if (params.has('date')) {
    const date = params.get('date');
    query = query.gte('taken_at', kolkataStart(date)).lt('taken_at', kolkataStart(nextDate(date)));
  } else {
    if (params.has('from')) query = query.gte('taken_at', kolkataStart(params.get('from')));
    if (params.has('to')) query = query.lt('taken_at', kolkataStart(nextDate(params.get('to'))));
  }
  if (params.has('employeeId')) query = query.eq('employee_id', Number(params.get('employeeId')));
  if (params.has('snackId')) query = query.eq('snack_id', Number(params.get('snackId')));
  return unwrap(await query, 'Could not load snack records').map(recordDto);
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
    let query = client.from(table).select('id,name,active,created_at');
    query = id ? query.eq('id', Number(id)).single() : query.order('name');
    const data = unwrap(await query, `Could not load ${table}`);
    return Array.isArray(data) ? data.map(entityDto) : entityDto(data);
  }
  if (method === 'POST') {
    return entityDto(unwrap(await client.from(table).insert({ name: body.name.trim(), active: body.active !== false }).select('id,name,active,created_at').single()));
  }
  if (method === 'PUT') {
    return entityDto(unwrap(await client.from(table).update({ name: body.name.trim(), active: body.active }).eq('id', Number(id)).select('id,name,active,created_at').single()));
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

  if (parts[0] === 'records' && parts.length === 1 && method === 'GET') return getRecords(request.searchParams);
  if (parts[0] === 'records' && parts.length === 1 && method === 'POST') {
    const row = unwrap(await client.from('snack_records').insert({ employee_id: body.employeeId, snack_id: body.snackId, quantity: body.quantity }).select(recordSelection).single());
    return recordDto(row);
  }
  if (parts[0] === 'records' && parts[1] === 'batch' && method === 'POST') {
    const rows = body.items.map(item => ({ employee_id: body.employeeId, snack_id: item.snackId, quantity: item.quantity }));
    return unwrap(await client.from('snack_records').insert(rows).select(recordSelection)).map(recordDto);
  }
  if (parts[0] === 'records' && parts[1] && method === 'GET') {
    const row = unwrap(await client.from('snack_records').select(recordSelection).eq('id', Number(parts[1])).single());
    return recordDto(row);
  }
  if (parts[0] === 'records' && parts[1] && method === 'PUT') {
    const row = unwrap(await client.from('snack_records').update({ employee_id: body.employeeId, snack_id: body.snackId, quantity: body.quantity }).eq('id', Number(parts[1])).select(recordSelection).single());
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
    return { employeeCount: employees, activeEmployeeCount: activeEmployees, activeSnackCount: activeSnacks, todayRecordCount: records.length, todayQuantity: records.reduce((sum, record) => sum + record.quantity, 0) };
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
    const rows = await getRecords(params);
    const employees = summarize(rows, 'employeeId', 'employeeName');
    const snacks = summarize(rows, 'snackId', 'snackName');
    return { totalRecords: rows.length, totalQuantity: rows.reduce((sum, row) => sum + row.quantity, 0), employees, snacks };
  }
  throw new Error(`Unsupported Supabase request: ${method} ${pathname}`);
}
