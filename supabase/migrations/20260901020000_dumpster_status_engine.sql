-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 2: dumpster status engine
-- =============================================================================
-- Single authoritative state machine for dumpster status changes.
--
-- A plpgsql function body is one atomic transaction, so the status UPDATE and
-- the status_log INSERT always commit or roll back together — satisfying the
-- "same transaction, not a follow-up call" requirement. supabase-js has no
-- client-side transaction API, so this belongs in the database regardless.
--
-- The TypeScript layer (lib/dumpsters/state-machine.ts) keeps a mirror of the
-- transition map, but ONLY to decide which action buttons to render. This
-- function is the enforcer.

-- -----------------------------------------------------------------------------
-- Transition rules
-- -----------------------------------------------------------------------------
--   available   -> reserved
--   reserved    -> deployed | available            (booking cancelled pre-drop)
--   deployed    -> overdue  | available            (returned on time)
--   overdue     -> available                       (returned late)
--   <any>       -> out_of_service                  (maintenance override)
--   out_of_service -> available                    (back from the shop only)
--
-- A no-op (x -> x) is NOT a valid transition.
create or replace function public.dumpster_transition_allowed(
  p_from public.dumpster_status,
  p_to   public.dumpster_status
)
returns boolean
language sql
immutable
as $$
  select case
    when p_from = p_to then false
    -- maintenance override: into out_of_service from anywhere
    when p_to = 'out_of_service' then true
    -- and back out only to available
    when p_from = 'out_of_service' then p_to = 'available'
    -- normal lifecycle
    when p_from = 'available' then p_to = 'reserved'
    when p_from = 'reserved'  then p_to in ('deployed', 'available')
    when p_from = 'deployed'  then p_to in ('overdue', 'available')
    when p_from = 'overdue'   then p_to = 'available'
    else false
  end;
$$;

-- -----------------------------------------------------------------------------
-- set_dumpster_status: the only sanctioned way to change dumpsters.status
-- -----------------------------------------------------------------------------
-- SECURITY INVOKER: the caller's RLS context applies, so the staff-only policy
-- on public.dumpsters is enforced. We also re-check is_staff() explicitly.
-- changed_by is taken from auth.uid() here, never from the client.
create or replace function public.set_dumpster_status(
  p_dumpster_id uuid,
  p_to          public.dumpster_status
)
returns public.dumpsters
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old public.dumpster_status;
  v_row public.dumpsters;
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may change dumpster status'
      using errcode = '42501';
  end if;

  select status into v_old
  from public.dumpsters
  where id = p_dumpster_id
  for update;

  if not found then
    raise exception 'Dumpster % not found', p_dumpster_id
      using errcode = 'P0002';
  end if;

  if not public.dumpster_transition_allowed(v_old, p_to) then
    raise exception 'Illegal dumpster status transition: % -> %', v_old, p_to
      using errcode = '23514';
  end if;

  update public.dumpsters
  set status = p_to
  where id = p_dumpster_id
  returning * into v_row;

  insert into public.status_log
    (entity_type, entity_id, old_status, new_status, changed_by)
  values
    ('dumpster', p_dumpster_id, v_old::text, p_to::text, auth.uid());

  return v_row;
end;
$$;

grant execute on function public.dumpster_transition_allowed(
  public.dumpster_status, public.dumpster_status
) to authenticated;
grant execute on function public.set_dumpster_status(
  uuid, public.dumpster_status
) to authenticated;

-- -----------------------------------------------------------------------------
-- log_dumpster_created: first status_log row (old_status NULL) for new units
-- -----------------------------------------------------------------------------
create or replace function public.log_dumpster_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.status_log
    (entity_type, entity_id, old_status, new_status, changed_by)
  values
    ('dumpster', new.id, null, new.status::text, auth.uid());
  return new;
end;
$$;

create trigger dumpsters_log_created
  after insert on public.dumpsters
  for each row execute function public.log_dumpster_created();
