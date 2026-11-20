import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

export const supabaseConfigError = (() => {
  if (!url) return 'VITE_SUPABASE_URL is missing. Set it in frontend/.env.local and restart Vite.';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    return 'VITE_SUPABASE_URL is invalid. Use the project URL beginning with https://, without backslashes or quotes.';
  }
  if (!publishableKey) return 'VITE_SUPABASE_PUBLISHABLE_KEY is missing. Set it in frontend/.env.local and restart Vite.';
  return '';
})();

export const supabase = supabaseConfigError ? null : createClient(url, publishableKey);

export async function loadCurrentProfile(userId) {
  if (!supabase) throw new Error(supabaseConfigError);
  const { data, error } = await supabase
    .from('user_profiles')
    .select('user_id, role, employee_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Your Supabase login has no Office Snacks profile yet. Run database/link_supabase_admin.sql in the SQL Editor for this same Supabase project, then sign in again.');
  return data;
}
