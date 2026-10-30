-- Idempotent synthetic seed (fixed IDs, no real data). Admin comes from 01_init (admin/umami).
set search_path to analyst_fixture;
insert into website (website_id, name, domain, user_id, created_by)
values ('a11a1a00-0000-4000-8000-000000000001', 'Synthetic analyst site', 'synthetic.invalid',
        '41e2b680-648e-4b09-bcd7-3e2b10c06264', '41e2b680-648e-4b09-bcd7-3e2b10c06264')
on conflict (website_id) do nothing;
-- 14 days x 3 sessions, one pageview each.
insert into session (session_id, website_id, browser, os, device, country, created_at)
select id, 'a11a1a00-0000-4000-8000-000000000001', 'chrome', 'Mac OS', 'desktop', 'ID', created
from (select md5('s' || d || '-' || s)::uuid id,
             timestamptz '2026-10-01 12:00Z' + d * interval '1 day' + s * interval '1 minute' created
      from generate_series(0, 13) d, generate_series(0, 2) s) x
on conflict (session_id) do nothing;
insert into website_event (event_id, website_id, session_id, visit_id, created_at, url_path, event_type, hostname)
select session_id, website_id, session_id, session_id, created_at,
       case when extract(minute from created_at) = 0 then '/' else '/pricing' end, 1, 'synthetic.invalid'
from session where website_id = 'a11a1a00-0000-4000-8000-000000000001'
on conflict (event_id) do nothing;
