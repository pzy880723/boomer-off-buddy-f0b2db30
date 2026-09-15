--
-- PostgreSQL database dump
--

\restrict c09IlJ8FakBN3lQGafJ8XsNzfoUppae1OehZc5bSDHjrDLSCPE1p3Hi0u4joB3C

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'SQL_ASCII';
SET standard_conforming_strings = off;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET escape_string_warning = off;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: commerce_after_sales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commerce_after_sales (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    after_sale_no text DEFAULT public.gen_commerce_after_sale_no() NOT NULL,
    order_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    location_id uuid NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    status text DEFAULT 'requested'::text NOT NULL,
    reason_code text NOT NULL,
    reason_text text,
    requested_amount numeric(12,2) NOT NULL,
    approved_amount numeric(12,2),
    evidence_urls jsonb DEFAULT '[]'::jsonb NOT NULL,
    return_tracking_no text,
    return_carrier text,
    assigned_to uuid,
    store_note text,
    rejection_reason text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    received_at timestamp with time zone,
    inspected_at timestamp with time zone,
    refund_requested_at timestamp with time zone,
    refunded_at timestamp with time zone,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commerce_after_sales_approved_amount_check CHECK ((approved_amount > (0)::numeric)),
    CONSTRAINT commerce_after_sales_requested_amount_check CHECK ((requested_amount > (0)::numeric)),
    CONSTRAINT commerce_after_sales_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'store_reviewing'::text, 'approved'::text, 'rejected'::text, 'customer_shipping'::text, 'store_received'::text, 'inspecting'::text, 'refund_pending'::text, 'refunded'::text, 'closed'::text, 'cancelled'::text]))),
    CONSTRAINT commerce_after_sales_type_check CHECK ((type = ANY (ARRAY['return_refund'::text, 'refund_only'::text])))
);


--
-- Name: commerce_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commerce_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_no text DEFAULT public.gen_commerce_order_no() NOT NULL,
    user_id uuid,
    payment_status text DEFAULT 'unpaid'::text NOT NULL,
    order_status text DEFAULT 'pending_payment'::text NOT NULL,
    currency text DEFAULT 'CNY'::text NOT NULL,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    shipping_fee numeric(12,2) DEFAULT 0 NOT NULL,
    discount_total numeric(12,2) DEFAULT 0 NOT NULL,
    total_amount numeric(12,2) DEFAULT 0 NOT NULL,
    recipient_name text,
    recipient_phone text,
    shipping_address jsonb,
    courier_provider text,
    courier_service_code text,
    courier_service_name text,
    courier_quote_snapshot jsonb,
    customer_note text,
    idempotency_key text NOT NULL,
    reservation_expires_at timestamp with time zone NOT NULL,
    provider_transaction_id text,
    paid_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_channel text DEFAULT 'storefront'::text NOT NULL,
    fulfillment_method text DEFAULT 'shipping'::text NOT NULL,
    sale_location_id uuid,
    operator_id uuid,
    customer_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    pos_shift_id uuid,
    discount_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    benefit_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    authorization_id uuid,
    payment_route jsonb,
    CONSTRAINT commerce_orders_courier_provider_check CHECK ((courier_provider = ANY (ARRAY['sf'::text, 'cainiao'::text, 'platform'::text]))),
    CONSTRAINT commerce_orders_fulfillment_method_check CHECK ((fulfillment_method = ANY (ARRAY['shipping'::text, 'pickup'::text, 'carryout'::text]))),
    CONSTRAINT commerce_orders_order_status_check CHECK ((order_status = ANY (ARRAY['pending_payment'::text, 'confirmed'::text, 'processing'::text, 'completed'::text, 'cancelled'::text, 'after_sale'::text, 'closed'::text]))),
    CONSTRAINT commerce_orders_payment_status_check CHECK ((payment_status = ANY (ARRAY['unpaid'::text, 'paid'::text, 'refund_pending'::text, 'partially_refunded'::text, 'refunded'::text, 'payment_failed'::text]))),
    CONSTRAINT commerce_orders_source_channel_check CHECK ((source_channel = ANY (ARRAY['storefront'::text, 'pos'::text, 'youzan'::text, 'manual'::text])))
);


--
-- Name: fulfillments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text DEFAULT ('FF-'::text || upper(substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 10))) NOT NULL,
    order_id uuid NOT NULL,
    location_id uuid NOT NULL,
    status text DEFAULT 'allocated'::text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    claimed_by uuid,
    claimed_device_id uuid,
    claimed_at timestamp with time zone,
    tote_id uuid,
    picking_started_at timestamp with time zone,
    picked_at timestamp with time zone,
    packing_started_at timestamp with time zone,
    packed_at timestamp with time zone,
    handed_over_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fulfillments_status_check CHECK ((status = ANY (ARRAY['unallocated'::text, 'allocated'::text, 'picking'::text, 'picked'::text, 'packing'::text, 'packed'::text, 'handover_ready'::text, 'handed_over'::text, 'exception'::text])))
);


--
-- Name: commerce_customer_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commerce_customer_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    kind text DEFAULT 'shortage'::text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    shortage_id uuid,
    order_id uuid,
    dedupe_key text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: commerce_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commerce_customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    external_subject text NOT NULL,
    phone text,
    wechat_openid text,
    wechat_unionid text,
    nickname text,
    avatar_url text,
    status text DEFAULT 'active'::text NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commerce_customers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'blocked'::text, 'deleted'::text])))
);


--
-- Name: commerce_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commerce_order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    listing_id uuid,
    sku_id uuid NOT NULL,
    location_id uuid NOT NULL,
    epc text,
    title_snapshot text NOT NULL,
    image_snapshot text,
    condition_snapshot text,
    unit_price numeric(12,2) NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    line_total numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    original_unit_price numeric(12,2),
    discount_total numeric(12,2) DEFAULT 0 NOT NULL,
    discount_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    ownership_snapshot text,
    settlement_subject_id uuid,
    settlement_snapshot jsonb,
    category_code text,
    category_name_snapshot text,
    subcategory_code text,
    subcategory_name_snapshot text,
    CONSTRAINT commerce_order_items_quantity_check CHECK ((quantity > 0))
);


--
-- Name: COLUMN commerce_order_items.settlement_snapshot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.commerce_order_items.settlement_snapshot IS 'Immutable store, subject, merchant, and amount facts captured before payment.';


--
-- Name: commerce_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commerce_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    provider text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    amount numeric(12,2) NOT NULL,
    currency text DEFAULT 'CNY'::text NOT NULL,
    provider_transaction_id text,
    idempotency_key text NOT NULL,
    payment_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone,
    failure_code text,
    failure_message text,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    payment_profile_id uuid,
    merchant_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    payment_channel text DEFAULT 'legacy'::text NOT NULL,
    merchant_order_no text,
    payer_openid text,
    prepay_id text,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    ordinary_checked_at timestamp with time zone,
    CONSTRAINT commerce_payments_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT commerce_payments_payment_channel_check CHECK ((payment_channel = ANY (ARRAY['legacy'::text, 'ordinary_wechat'::text]))),
    CONSTRAINT commerce_payments_provider_check CHECK ((provider = ANY (ARRAY['cash'::text, 'wechat'::text, 'alipay'::text, 'bank_card'::text, 'store_credit'::text, 'manual'::text]))),
    CONSTRAINT commerce_payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'partially_refunded'::text, 'refunded'::text])))
);


--
-- Name: commerce_refund_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commerce_refund_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortage_id uuid NOT NULL,
    order_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    after_sale_id uuid,
    refund_id uuid,
    amount_fen integer NOT NULL,
    goods_fen integer DEFAULT 0 NOT NULL,
    shipping_fen integer DEFAULT 0 NOT NULL,
    quote_version text NOT NULL,
    idempotency_key text NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    succeeded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commerce_refund_intents_amount_fen_check CHECK ((amount_fen > 0)),
    CONSTRAINT commerce_refund_intents_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'manual_review'::text])))
);


--
-- Name: commerce_refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commerce_refunds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    after_sale_id uuid,
    provider text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    amount numeric(12,2) NOT NULL,
    reason text,
    idempotency_key text NOT NULL,
    provider_refund_id text,
    requested_by uuid,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    refunded_at timestamp with time zone,
    failure_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    merchant_refund_no text,
    route_snapshot jsonb,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    ordinary_checked_at timestamp with time zone,
    CONSTRAINT commerce_refunds_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT commerce_refunds_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: commerce_sms_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commerce_sms_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_key text NOT NULL,
    phone text NOT NULL,
    params jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    provider_serial text,
    provider_code text,
    provider_message text,
    dedupe_key text,
    shortage_id uuid,
    order_id uuid,
    customer_id uuid,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commerce_sms_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'template_missing'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped_disabled'::text])))
);


--
-- Name: fulfillment_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillment_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fulfillment_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    sku_id uuid NOT NULL,
    epc text,
    expected_qty integer DEFAULT 1 NOT NULL,
    picked_qty integer DEFAULT 0 NOT NULL,
    packed_qty integer DEFAULT 0 NOT NULL,
    picked_at timestamp with time zone,
    packed_at timestamp with time zone,
    CONSTRAINT fulfillment_items_expected_qty_check CHECK ((expected_qty > 0)),
    CONSTRAINT fulfillment_items_packed_qty_check CHECK (((packed_qty >= 0) AND (packed_qty <= expected_qty))),
    CONSTRAINT fulfillment_items_picked_qty_check CHECK (((picked_qty >= 0) AND (picked_qty <= expected_qty)))
);


--
-- Name: fulfillment_shortages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fulfillment_shortages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fulfillment_id uuid NOT NULL,
    fulfillment_item_id uuid NOT NULL,
    exception_id uuid,
    order_id uuid,
    quantity integer NOT NULL,
    reason text,
    status text DEFAULT 'pending_customer'::text NOT NULL,
    refund_state text DEFAULT 'not_required'::text NOT NULL,
    reported_by uuid,
    device_id uuid,
    client_op_id text,
    customer_responded_at timestamp with time zone,
    customer_response_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    order_item_id uuid,
    location_id uuid,
    product_name text,
    image_ref text,
    quote_version text,
    refund_goods_fen integer,
    refund_shipping_fen integer,
    refund_total_fen integer,
    quote_snapshot jsonb,
    after_sale_id uuid,
    refund_intent_id uuid,
    refund_requested_at timestamp with time zone,
    refunded_at timestamp with time zone,
    CONSTRAINT fulfillment_shortages_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT fulfillment_shortages_refund_state_check CHECK ((refund_state = ANY (ARRAY['not_required'::text, 'refund_pending'::text, 'refund_completed'::text, 'awaiting_confirmation'::text, 'queued'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'manual_review'::text]))),
    CONSTRAINT fulfillment_shortages_status_check CHECK ((status = ANY (ARRAY['pending_customer'::text, 'customer_accepted'::text, 'customer_cancelled'::text, 'withdrawn'::text])))
);


--
-- Name: shipments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fulfillment_id uuid NOT NULL,
    package_id uuid,
    provider text NOT NULL,
    service_code text NOT NULL,
    status text DEFAULT 'not_created'::text NOT NULL,
    provider_order_no text,
    tracking_no text,
    idempotency_key text NOT NULL,
    label_payload jsonb,
    pickup_window jsonb,
    last_error text,
    booked_at timestamp with time zone,
    picked_up_at timestamp with time zone,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shipments_provider_check CHECK ((provider = ANY (ARRAY['sf'::text, 'cainiao'::text]))),
    CONSTRAINT shipments_status_check CHECK ((status = ANY (ARRAY['not_created'::text, 'quoting'::text, 'booked'::text, 'label_created'::text, 'picked_up'::text, 'in_transit'::text, 'delivered'::text, 'cancelled'::text, 'failed'::text])))
);


--
-- Name: commerce_after_sales commerce_after_sales_after_sale_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_after_sales
    ADD CONSTRAINT commerce_after_sales_after_sale_no_key UNIQUE (after_sale_no);


--
-- Name: commerce_after_sales commerce_after_sales_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_after_sales
    ADD CONSTRAINT commerce_after_sales_pkey PRIMARY KEY (id);


--
-- Name: commerce_customer_notifications commerce_customer_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_customer_notifications
    ADD CONSTRAINT commerce_customer_notifications_pkey PRIMARY KEY (id);


--
-- Name: commerce_customers commerce_customers_external_subject_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_customers
    ADD CONSTRAINT commerce_customers_external_subject_key UNIQUE (external_subject);


--
-- Name: commerce_customers commerce_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_customers
    ADD CONSTRAINT commerce_customers_pkey PRIMARY KEY (id);


--
-- Name: commerce_order_items commerce_order_items_order_id_listing_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_order_items
    ADD CONSTRAINT commerce_order_items_order_id_listing_id_key UNIQUE (order_id, listing_id);


--
-- Name: commerce_order_items commerce_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_order_items
    ADD CONSTRAINT commerce_order_items_pkey PRIMARY KEY (id);


--
-- Name: commerce_orders commerce_orders_order_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_orders
    ADD CONSTRAINT commerce_orders_order_no_key UNIQUE (order_no);


--
-- Name: commerce_orders commerce_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_orders
    ADD CONSTRAINT commerce_orders_pkey PRIMARY KEY (id);


--
-- Name: commerce_orders commerce_orders_provider_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_orders
    ADD CONSTRAINT commerce_orders_provider_transaction_id_key UNIQUE (provider_transaction_id);


--
-- Name: commerce_orders commerce_orders_user_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_orders
    ADD CONSTRAINT commerce_orders_user_id_idempotency_key_key UNIQUE (user_id, idempotency_key);


--
-- Name: commerce_payments commerce_payments_merchant_order_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_payments
    ADD CONSTRAINT commerce_payments_merchant_order_no_key UNIQUE (merchant_order_no);


--
-- Name: commerce_payments commerce_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_payments
    ADD CONSTRAINT commerce_payments_pkey PRIMARY KEY (id);


--
-- Name: commerce_payments commerce_payments_provider_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_payments
    ADD CONSTRAINT commerce_payments_provider_idempotency_key_key UNIQUE (provider, idempotency_key);


--
-- Name: commerce_refund_intents commerce_refund_intents_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refund_intents
    ADD CONSTRAINT commerce_refund_intents_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: commerce_refund_intents commerce_refund_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refund_intents
    ADD CONSTRAINT commerce_refund_intents_pkey PRIMARY KEY (id);


--
-- Name: commerce_refund_intents commerce_refund_intents_shortage_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refund_intents
    ADD CONSTRAINT commerce_refund_intents_shortage_id_key UNIQUE (shortage_id);


--
-- Name: commerce_refunds commerce_refunds_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refunds
    ADD CONSTRAINT commerce_refunds_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: commerce_refunds commerce_refunds_merchant_refund_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refunds
    ADD CONSTRAINT commerce_refunds_merchant_refund_no_key UNIQUE (merchant_refund_no);


--
-- Name: commerce_refunds commerce_refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refunds
    ADD CONSTRAINT commerce_refunds_pkey PRIMARY KEY (id);


--
-- Name: commerce_sms_outbox commerce_sms_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_sms_outbox
    ADD CONSTRAINT commerce_sms_outbox_pkey PRIMARY KEY (id);


--
-- Name: fulfillment_items fulfillment_items_fulfillment_order_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_items
    ADD CONSTRAINT fulfillment_items_fulfillment_order_sku_key UNIQUE (fulfillment_id, order_item_id, sku_id);


--
-- Name: fulfillment_items fulfillment_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_items
    ADD CONSTRAINT fulfillment_items_pkey PRIMARY KEY (id);


--
-- Name: fulfillment_shortages fulfillment_shortages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_shortages
    ADD CONSTRAINT fulfillment_shortages_pkey PRIMARY KEY (id);


--
-- Name: fulfillments fulfillments_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillments
    ADD CONSTRAINT fulfillments_code_key UNIQUE (code);


--
-- Name: fulfillments fulfillments_order_id_location_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillments
    ADD CONSTRAINT fulfillments_order_id_location_id_key UNIQUE (order_id, location_id);


--
-- Name: fulfillments fulfillments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillments
    ADD CONSTRAINT fulfillments_pkey PRIMARY KEY (id);


--
-- Name: shipments shipments_fulfillment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_fulfillment_id_key UNIQUE (fulfillment_id);


--
-- Name: shipments shipments_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: shipments shipments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_pkey PRIMARY KEY (id);


--
-- Name: commerce_customer_notifications_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commerce_customer_notifications_customer_idx ON public.commerce_customer_notifications USING btree (customer_id, created_at DESC);


--
-- Name: commerce_customer_notifications_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX commerce_customer_notifications_dedupe ON public.commerce_customer_notifications USING btree (customer_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: commerce_customers_phone_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX commerce_customers_phone_unique ON public.commerce_customers USING btree (phone) WHERE (phone IS NOT NULL);


--
-- Name: commerce_customers_wechat_unionid_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX commerce_customers_wechat_unionid_unique ON public.commerce_customers USING btree (wechat_unionid) WHERE (wechat_unionid IS NOT NULL);


--
-- Name: commerce_refund_intents_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commerce_refund_intents_claim_idx ON public.commerce_refund_intents USING btree (state, next_attempt_at);


--
-- Name: commerce_sms_outbox_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX commerce_sms_outbox_dedupe ON public.commerce_sms_outbox USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: commerce_sms_outbox_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commerce_sms_outbox_pending_idx ON public.commerce_sms_outbox USING btree (status, created_at);


--
-- Name: idx_commerce_after_sales_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commerce_after_sales_order ON public.commerce_after_sales USING btree (order_id, requested_at DESC);


--
-- Name: idx_commerce_after_sales_store_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commerce_after_sales_store_status ON public.commerce_after_sales USING btree (location_id, status, requested_at DESC);


--
-- Name: idx_commerce_order_items_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commerce_order_items_order ON public.commerce_order_items USING btree (order_id);


--
-- Name: idx_commerce_order_items_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commerce_order_items_order_id ON public.commerce_order_items USING btree (order_id);


--
-- Name: idx_commerce_order_items_settlement_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commerce_order_items_settlement_subject ON public.commerce_order_items USING btree (settlement_subject_id);


--
-- Name: idx_commerce_orders_reservation_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commerce_orders_reservation_expiry ON public.commerce_orders USING btree (reservation_expires_at) WHERE ((payment_status = 'unpaid'::text) AND (order_status = 'pending_payment'::text));


--
-- Name: idx_commerce_orders_sale_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commerce_orders_sale_location ON public.commerce_orders USING btree (sale_location_id, created_at DESC);


--
-- Name: idx_commerce_orders_source_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commerce_orders_source_created ON public.commerce_orders USING btree (source_channel, created_at DESC);


--
-- Name: idx_commerce_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commerce_orders_status ON public.commerce_orders USING btree (order_status, created_at DESC);


--
-- Name: idx_commerce_orders_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commerce_orders_user ON public.commerce_orders USING btree (user_id, created_at DESC);


--
-- Name: idx_commerce_payments_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commerce_payments_order ON public.commerce_payments USING btree (order_id, created_at);


--
-- Name: idx_fulfillment_shortages_fulfillment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fulfillment_shortages_fulfillment ON public.fulfillment_shortages USING btree (fulfillment_id, status);


--
-- Name: idx_fulfillments_location_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fulfillments_location_status ON public.fulfillments USING btree (location_id, status, priority DESC);


--
-- Name: idx_fulfillments_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fulfillments_order_id ON public.fulfillments USING btree (order_id);


--
-- Name: idx_ordinary_payments_recovery; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ordinary_payments_recovery ON public.commerce_payments USING btree (ordinary_checked_at NULLS FIRST, created_at) WHERE ((payment_channel = 'ordinary_wechat'::text) AND (status = ANY (ARRAY['pending'::text, 'processing'::text, 'failed'::text])));


--
-- Name: idx_ordinary_refunds_recovery; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ordinary_refunds_recovery ON public.commerce_refunds USING btree (ordinary_checked_at NULLS FIRST, created_at) WHERE ((merchant_refund_no IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'processing'::text, 'failed'::text])));


--
-- Name: uniq_active_commerce_after_sale_item; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_active_commerce_after_sale_item ON public.commerce_after_sales USING btree (order_item_id) WHERE (status <> ALL (ARRAY['rejected'::text, 'refunded'::text, 'closed'::text, 'cancelled'::text]));


--
-- Name: uniq_commerce_payment_provider_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_commerce_payment_provider_transaction ON public.commerce_payments USING btree (provider, provider_transaction_id) WHERE (provider_transaction_id IS NOT NULL);


--
-- Name: uniq_ordinary_payment_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_ordinary_payment_order ON public.commerce_payments USING btree (order_id) WHERE (payment_channel = 'ordinary_wechat'::text);


--
-- Name: uniq_ordinary_refund_after_sale; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_ordinary_refund_after_sale ON public.commerce_refunds USING btree (after_sale_id) WHERE (merchant_refund_no IS NOT NULL);


--
-- Name: uniq_pos_order_client_op; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_pos_order_client_op ON public.commerce_orders USING btree (idempotency_key) WHERE (source_channel = 'pos'::text);


--
-- Name: uniq_storefront_customer_order_op; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_storefront_customer_order_op ON public.commerce_orders USING btree (customer_id, idempotency_key) WHERE ((source_channel = 'storefront'::text) AND (customer_id IS NOT NULL));


--
-- Name: uq_fulfillment_shortages_client_op; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_fulfillment_shortages_client_op ON public.fulfillment_shortages USING btree (fulfillment_id, client_op_id) WHERE (client_op_id IS NOT NULL);


--
-- Name: commerce_orders commerce_assign_storefront_customer; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER commerce_assign_storefront_customer BEFORE INSERT OR UPDATE OF user_id, customer_id, source_channel ON public.commerce_orders FOR EACH ROW EXECUTE FUNCTION public.commerce_assign_storefront_customer();


--
-- Name: commerce_orders commerce_order_coupon_resolution; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER commerce_order_coupon_resolution AFTER UPDATE OF payment_status, order_status ON public.commerce_orders FOR EACH ROW EXECUTE FUNCTION public.commerce_resolve_order_coupon();


--
-- Name: commerce_refund_intents commerce_refund_intents_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER commerce_refund_intents_touch BEFORE UPDATE ON public.commerce_refund_intents FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();


--
-- Name: commerce_sms_outbox commerce_sms_outbox_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER commerce_sms_outbox_touch BEFORE UPDATE ON public.commerce_sms_outbox FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();


--
-- Name: commerce_orders ordinary_order_route_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ordinary_order_route_immutable BEFORE UPDATE ON public.commerce_orders FOR EACH ROW EXECUTE FUNCTION public.commerce_ordinary_immutable_snapshot();


--
-- Name: commerce_payments ordinary_payment_snapshot_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ordinary_payment_snapshot_immutable BEFORE UPDATE ON public.commerce_payments FOR EACH ROW EXECUTE FUNCTION public.commerce_ordinary_immutable_snapshot();


--
-- Name: commerce_refunds ordinary_refund_snapshot_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ordinary_refund_snapshot_immutable BEFORE UPDATE ON public.commerce_refunds FOR EACH ROW EXECUTE FUNCTION public.commerce_ordinary_immutable_snapshot();


--
-- Name: fulfillments trg_fulfillment_enqueue_pick_ticket; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_fulfillment_enqueue_pick_ticket AFTER INSERT ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_enqueue_pick_ticket();


--
-- Name: fulfillment_shortages trg_fulfillment_shortage_insert_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_fulfillment_shortage_insert_guard BEFORE INSERT ON public.fulfillment_shortages FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_shortage_insert_guard();


--
-- Name: fulfillment_shortages trg_fulfillment_shortages_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_fulfillment_shortages_updated_at BEFORE UPDATE ON public.fulfillment_shortages FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();


--
-- Name: commerce_after_sales commerce_after_sales_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_after_sales
    ADD CONSTRAINT commerce_after_sales_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.inv_locations(id) ON DELETE RESTRICT;


--
-- Name: commerce_after_sales commerce_after_sales_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_after_sales
    ADD CONSTRAINT commerce_after_sales_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id) ON DELETE RESTRICT;


--
-- Name: commerce_after_sales commerce_after_sales_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_after_sales
    ADD CONSTRAINT commerce_after_sales_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.commerce_order_items(id) ON DELETE RESTRICT;


--
-- Name: commerce_customer_notifications commerce_customer_notifications_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_customer_notifications
    ADD CONSTRAINT commerce_customer_notifications_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.commerce_customers(id) ON DELETE CASCADE;


--
-- Name: commerce_customer_notifications commerce_customer_notifications_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_customer_notifications
    ADD CONSTRAINT commerce_customer_notifications_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id) ON DELETE CASCADE;


--
-- Name: commerce_customer_notifications commerce_customer_notifications_shortage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_customer_notifications
    ADD CONSTRAINT commerce_customer_notifications_shortage_id_fkey FOREIGN KEY (shortage_id) REFERENCES public.fulfillment_shortages(id) ON DELETE CASCADE;


--
-- Name: commerce_order_items commerce_order_items_listing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_order_items
    ADD CONSTRAINT commerce_order_items_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.commerce_listings(id);


--
-- Name: commerce_order_items commerce_order_items_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_order_items
    ADD CONSTRAINT commerce_order_items_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.inv_locations(id);


--
-- Name: commerce_order_items commerce_order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_order_items
    ADD CONSTRAINT commerce_order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id) ON DELETE CASCADE;


--
-- Name: commerce_order_items commerce_order_items_settlement_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_order_items
    ADD CONSTRAINT commerce_order_items_settlement_subject_id_fkey FOREIGN KEY (settlement_subject_id) REFERENCES public.payment_subjects(id);


--
-- Name: commerce_order_items commerce_order_items_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_order_items
    ADD CONSTRAINT commerce_order_items_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.inv_skus(id);


--
-- Name: commerce_orders commerce_orders_authorization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_orders
    ADD CONSTRAINT commerce_orders_authorization_id_fkey FOREIGN KEY (authorization_id) REFERENCES public.pos_authorizations(id);


--
-- Name: commerce_orders commerce_orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_orders
    ADD CONSTRAINT commerce_orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.commerce_customers(id);


--
-- Name: commerce_orders commerce_orders_pos_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_orders
    ADD CONSTRAINT commerce_orders_pos_shift_id_fkey FOREIGN KEY (pos_shift_id) REFERENCES public.pos_shifts(id);


--
-- Name: commerce_orders commerce_orders_sale_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_orders
    ADD CONSTRAINT commerce_orders_sale_location_id_fkey FOREIGN KEY (sale_location_id) REFERENCES public.inv_locations(id);


--
-- Name: commerce_payments commerce_payments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_payments
    ADD CONSTRAINT commerce_payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id) ON DELETE CASCADE;


--
-- Name: commerce_payments commerce_payments_payment_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_payments
    ADD CONSTRAINT commerce_payments_payment_profile_id_fkey FOREIGN KEY (payment_profile_id) REFERENCES public.store_payment_profiles(id);


--
-- Name: commerce_refund_intents commerce_refund_intents_after_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refund_intents
    ADD CONSTRAINT commerce_refund_intents_after_sale_id_fkey FOREIGN KEY (after_sale_id) REFERENCES public.commerce_after_sales(id) ON DELETE SET NULL;


--
-- Name: commerce_refund_intents commerce_refund_intents_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refund_intents
    ADD CONSTRAINT commerce_refund_intents_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.commerce_customers(id) ON DELETE RESTRICT;


--
-- Name: commerce_refund_intents commerce_refund_intents_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refund_intents
    ADD CONSTRAINT commerce_refund_intents_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id) ON DELETE CASCADE;


--
-- Name: commerce_refund_intents commerce_refund_intents_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refund_intents
    ADD CONSTRAINT commerce_refund_intents_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.commerce_payments(id) ON DELETE RESTRICT;


--
-- Name: commerce_refund_intents commerce_refund_intents_refund_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refund_intents
    ADD CONSTRAINT commerce_refund_intents_refund_id_fkey FOREIGN KEY (refund_id) REFERENCES public.commerce_refunds(id) ON DELETE SET NULL;


--
-- Name: commerce_refund_intents commerce_refund_intents_shortage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refund_intents
    ADD CONSTRAINT commerce_refund_intents_shortage_id_fkey FOREIGN KEY (shortage_id) REFERENCES public.fulfillment_shortages(id) ON DELETE CASCADE;


--
-- Name: commerce_refunds commerce_refunds_after_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refunds
    ADD CONSTRAINT commerce_refunds_after_sale_id_fkey FOREIGN KEY (after_sale_id) REFERENCES public.commerce_after_sales(id);


--
-- Name: commerce_refunds commerce_refunds_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refunds
    ADD CONSTRAINT commerce_refunds_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id);


--
-- Name: commerce_refunds commerce_refunds_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_refunds
    ADD CONSTRAINT commerce_refunds_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.commerce_payments(id);


--
-- Name: commerce_sms_outbox commerce_sms_outbox_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_sms_outbox
    ADD CONSTRAINT commerce_sms_outbox_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.commerce_customers(id) ON DELETE SET NULL;


--
-- Name: commerce_sms_outbox commerce_sms_outbox_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_sms_outbox
    ADD CONSTRAINT commerce_sms_outbox_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id) ON DELETE SET NULL;


--
-- Name: commerce_sms_outbox commerce_sms_outbox_shortage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commerce_sms_outbox
    ADD CONSTRAINT commerce_sms_outbox_shortage_id_fkey FOREIGN KEY (shortage_id) REFERENCES public.fulfillment_shortages(id) ON DELETE SET NULL;


--
-- Name: fulfillment_items fulfillment_items_fulfillment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_items
    ADD CONSTRAINT fulfillment_items_fulfillment_id_fkey FOREIGN KEY (fulfillment_id) REFERENCES public.fulfillments(id) ON DELETE CASCADE;


--
-- Name: fulfillment_items fulfillment_items_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_items
    ADD CONSTRAINT fulfillment_items_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.commerce_order_items(id);


--
-- Name: fulfillment_items fulfillment_items_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_items
    ADD CONSTRAINT fulfillment_items_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.inv_skus(id);


--
-- Name: fulfillment_shortages fulfillment_shortages_after_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_shortages
    ADD CONSTRAINT fulfillment_shortages_after_sale_id_fkey FOREIGN KEY (after_sale_id) REFERENCES public.commerce_after_sales(id);


--
-- Name: fulfillment_shortages fulfillment_shortages_exception_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_shortages
    ADD CONSTRAINT fulfillment_shortages_exception_id_fkey FOREIGN KEY (exception_id) REFERENCES public.fulfillment_exceptions(id) ON DELETE SET NULL;


--
-- Name: fulfillment_shortages fulfillment_shortages_fulfillment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_shortages
    ADD CONSTRAINT fulfillment_shortages_fulfillment_id_fkey FOREIGN KEY (fulfillment_id) REFERENCES public.fulfillments(id) ON DELETE CASCADE;


--
-- Name: fulfillment_shortages fulfillment_shortages_fulfillment_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_shortages
    ADD CONSTRAINT fulfillment_shortages_fulfillment_item_id_fkey FOREIGN KEY (fulfillment_item_id) REFERENCES public.fulfillment_items(id) ON DELETE CASCADE;


--
-- Name: fulfillment_shortages fulfillment_shortages_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_shortages
    ADD CONSTRAINT fulfillment_shortages_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.inv_locations(id);


--
-- Name: fulfillment_shortages fulfillment_shortages_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_shortages
    ADD CONSTRAINT fulfillment_shortages_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id) ON DELETE CASCADE;


--
-- Name: fulfillment_shortages fulfillment_shortages_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillment_shortages
    ADD CONSTRAINT fulfillment_shortages_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.commerce_order_items(id);


--
-- Name: fulfillments fulfillments_claimed_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillments
    ADD CONSTRAINT fulfillments_claimed_device_id_fkey FOREIGN KEY (claimed_device_id) REFERENCES public.inv_handheld_devices(id);


--
-- Name: fulfillments fulfillments_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillments
    ADD CONSTRAINT fulfillments_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.inv_locations(id);


--
-- Name: fulfillments fulfillments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillments
    ADD CONSTRAINT fulfillments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id) ON DELETE CASCADE;


--
-- Name: fulfillments fulfillments_tote_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fulfillments
    ADD CONSTRAINT fulfillments_tote_fk FOREIGN KEY (tote_id) REFERENCES public.warehouse_totes(id);


--
-- Name: shipments shipments_fulfillment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_fulfillment_id_fkey FOREIGN KEY (fulfillment_id) REFERENCES public.fulfillments(id) ON DELETE CASCADE;


--
-- Name: shipments shipments_package_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_package_id_fkey FOREIGN KEY (package_id) REFERENCES public.packages(id);


--
-- Name: commerce_after_sales; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commerce_after_sales ENABLE ROW LEVEL SECURITY;

--
-- Name: commerce_customer_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commerce_customer_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: commerce_customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commerce_customers ENABLE ROW LEVEL SECURITY;

--
-- Name: commerce_order_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commerce_order_items ENABLE ROW LEVEL SECURITY;

--
-- Name: commerce_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commerce_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: commerce_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commerce_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: commerce_refund_intents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commerce_refund_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: commerce_refunds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commerce_refunds ENABLE ROW LEVEL SECURITY;

--
-- Name: commerce_sms_outbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commerce_sms_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: fulfillment_shortages fulfillment shortages are backend only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "fulfillment shortages are backend only" ON public.fulfillment_shortages TO service_role USING (true) WITH CHECK (true);


--
-- Name: fulfillment_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fulfillment_items ENABLE ROW LEVEL SECURITY;

--
-- Name: fulfillment_shortages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fulfillment_shortages ENABLE ROW LEVEL SECURITY;

--
-- Name: fulfillments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fulfillments ENABLE ROW LEVEL SECURITY;

--
-- Name: commerce_sms_outbox service role manages business sms outbox; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role manages business sms outbox" ON public.commerce_sms_outbox TO service_role USING (true) WITH CHECK (true);


--
-- Name: commerce_customer_notifications service role manages customer notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role manages customer notifications" ON public.commerce_customer_notifications TO service_role USING (true) WITH CHECK (true);


--
-- Name: commerce_refund_intents service role manages refund intents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role manages refund intents" ON public.commerce_refund_intents TO service_role USING (true) WITH CHECK (true);


--
-- Name: shipments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict c09IlJ8FakBN3lQGafJ8XsNzfoUppae1OehZc5bSDHjrDLSCPE1p3Hi0u4joB3C

