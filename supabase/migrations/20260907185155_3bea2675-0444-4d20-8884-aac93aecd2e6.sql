revoke all on public.go_authorization_snapshots from anon;
revoke all on public.go_authorization_snapshots from authenticated;
revoke all on public.go_authorization_snapshots from public;
grant all on public.go_authorization_snapshots to service_role;