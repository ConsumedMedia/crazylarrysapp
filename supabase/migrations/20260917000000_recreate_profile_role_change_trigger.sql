-- =============================================================================
-- Crazy Larry's Dumpsters — recreate the missing profiles role-change trigger
-- =============================================================================
-- Discovered while verifying 20260911000000: public.profiles had NO trigger
-- calling enforce_profile_role_change() at all. The function body was correct
-- (confirmed via pg_get_functiondef), but with no trigger wired up, nothing
-- was ever enforcing it — not the original is_staff() bar from 20260901000000,
-- and not the is_owner()-for-'owner' tightening from 20260911000000. Live
-- test: a plain staff session was able to set another profile's role straight
-- to 'owner', and to demote the owner account, with no error either way.
--
-- Root cause unknown (never applied, or dropped later) — not something this
-- migration can determine after the fact. This just restores it.
-- =============================================================================

drop trigger if exists profiles_enforce_role_change on public.profiles;

create trigger profiles_enforce_role_change
  before update on public.profiles
  for each row execute function public.enforce_profile_role_change();
