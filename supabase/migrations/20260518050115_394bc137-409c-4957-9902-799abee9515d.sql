-- 创建超级管理员账号：手机号 18657433310 / 密码 pzy5565283
-- 使用 Supabase 的 pgcrypto 扩展生成 bcrypt 密码
DO $$
DECLARE
  v_phone text := '18657433310';
  v_password text := 'pzy5565283';
  v_user_id uuid;
BEGIN
  -- 已存在则跳过
  IF EXISTS (SELECT 1 FROM auth.users WHERE phone = v_phone) THEN
    RAISE NOTICE 'User with phone % already exists, skipping', v_phone;
    RETURN;
  END IF;

  v_user_id := gen_random_uuid();

  INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    phone,
    encrypted_password,
    email_confirmed_at,
    phone_confirmed_at,
    confirmation_sent_at,
    last_sign_in_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    is_super_admin,
    is_sso_user,
    is_anonymous
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_user_id,
    'authenticated',
    'authenticated',
    NULL,
    v_phone,
    crypt(v_password, gen_salt('bf')),
    NULL,
    now(),
    NULL,
    NULL,
    jsonb_build_object('provider', 'phone', 'providers', jsonb_build_array('phone')),
    '{}'::jsonb,
    now(),
    now(),
    false,
    false,
    false
  );

  INSERT INTO auth.identities (
    id,
    user_id,
    provider_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    v_user_id,
    v_user_id::text,
    jsonb_build_object('sub', v_user_id::text, 'phone', v_phone, 'phone_verified', true),
    'phone',
    now(),
    now(),
    now()
  );

  RAISE NOTICE 'Created admin user % with phone %', v_user_id, v_phone;
END $$;