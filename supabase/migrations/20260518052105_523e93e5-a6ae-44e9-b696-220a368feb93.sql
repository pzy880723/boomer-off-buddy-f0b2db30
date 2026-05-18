
update auth.users
   set email = '18657433310@users.local',
       email_confirmed_at = coalesce(email_confirmed_at, now())
 where phone = '18657433310';

insert into auth.identities (id, user_id, provider, provider_id,
                              identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, 'email', u.id::text,
       jsonb_build_object('sub', u.id::text, 'email', '18657433310@users.local',
                          'email_verified', true),
       now(), now(), now()
  from auth.users u
 where u.phone = '18657433310'
   and not exists (
     select 1 from auth.identities i
      where i.user_id = u.id and i.provider = 'email'
   );
