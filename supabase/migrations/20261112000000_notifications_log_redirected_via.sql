-- Plan B.3: record which test variable redirected a send.
--
-- notifications_log already keeps original_recipient (the intended recipient)
-- when test mode redirected a send. It doesn't keep WHICH variable did it, so
-- the booking page can only say "to the test address" for logged sends. This
-- adds that name, never the value.
--
-- Nullable, no default, no backfill: the rows written before this migration
-- never recorded the variable, so they stay null. Today's app code never
-- mentions the column, so its inserts keep working (null always passes).
--
-- Grants: none needed. notifications_log is granted table-wide (no column
-- grants), so the existing SELECT for authenticated covers the new column and
-- staff read it through "notifications_log: staff full access"; an active
-- driver sees it on their own rows. anon still has nothing. RLS unchanged.

alter table public.notifications_log
  add column redirected_via text;

alter table public.notifications_log
  add constraint notifications_log_redirected_via_check check (
    redirected_via is null
    or (
      original_recipient is not null
      and (
           (redirected_via = 'CL_NOTIFICATIONS_TEST_PHONE' and channel = 'sms')
        or (redirected_via = 'CL_NOTIFICATIONS_TEST_EMAIL' and channel = 'email')
        or  redirected_via = 'CL_NOTIFICATIONS_TEST_TO'
      )
    )
  );

comment on column public.notifications_log.redirected_via is
  'Test mode only: the name of the variable (CL_NOTIFICATIONS_TEST_PHONE, _EMAIL or _TO) whose value this send was redirected to. A variable name, never its value. Null when not redirected, and on rows written before 20261112000000.';
