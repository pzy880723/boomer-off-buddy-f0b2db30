export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      aigc_sso_tickets: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          ip: string | null
          token_hash: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          ip?: string | null
          token_hash: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          ip?: string | null
          token_hash?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      auth_phone_otp: {
        Row: {
          attempts: number
          code_hash: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          ip: string | null
          phone: string
          purpose: string
          user_agent: string | null
        }
        Insert: {
          attempts?: number
          code_hash: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          ip?: string | null
          phone: string
          purpose?: string
          user_agent?: string | null
        }
        Update: {
          attempts?: number
          code_hash?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          ip?: string | null
          phone?: string
          purpose?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      channel_sync_outbox: {
        Row: {
          action: string
          attempts: number
          channel: string
          channel_listing_id: string | null
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          dedupe_key: string
          id: string
          inventory_version: number
          last_error: string | null
          lease_expires_at: string | null
          max_attempts: number
          next_run_at: string
          priority: number
          request_payload: Json
          response_preview: string | null
          shop_id: string | null
          sku_id: string
          status: string
          target_stock: number | null
          trace_id: string | null
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          action: string
          attempts?: number
          channel: string
          channel_listing_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          dedupe_key: string
          id?: string
          inventory_version?: number
          last_error?: string | null
          lease_expires_at?: string | null
          max_attempts?: number
          next_run_at?: string
          priority?: number
          request_payload?: Json
          response_preview?: string | null
          shop_id?: string | null
          sku_id: string
          status?: string
          target_stock?: number | null
          trace_id?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          action?: string
          attempts?: number
          channel?: string
          channel_listing_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          dedupe_key?: string
          id?: string
          inventory_version?: number
          last_error?: string | null
          lease_expires_at?: string | null
          max_attempts?: number
          next_run_at?: string
          priority?: number
          request_payload?: Json
          response_preview?: string | null
          shop_id?: string | null
          sku_id?: string
          status?: string
          target_stock?: number | null
          trace_id?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "channel_sync_outbox_channel_listing_id_fkey"
            columns: ["channel_listing_id"]
            isOneToOne: false
            referencedRelation: "sku_channel_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_sync_outbox_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      commerce_after_sales: {
        Row: {
          after_sale_no: string
          approved_amount: number | null
          assigned_to: string | null
          closed_at: string | null
          created_at: string
          evidence_urls: Json
          id: string
          inspected_at: string | null
          location_id: string
          order_id: string
          order_item_id: string
          reason_code: string
          reason_text: string | null
          received_at: string | null
          refund_requested_at: string | null
          refunded_at: string | null
          rejection_reason: string | null
          requested_amount: number
          requested_at: string
          return_carrier: string | null
          return_tracking_no: string | null
          reviewed_at: string | null
          status: string
          store_note: string | null
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          after_sale_no?: string
          approved_amount?: number | null
          assigned_to?: string | null
          closed_at?: string | null
          created_at?: string
          evidence_urls?: Json
          id?: string
          inspected_at?: string | null
          location_id: string
          order_id: string
          order_item_id: string
          reason_code: string
          reason_text?: string | null
          received_at?: string | null
          refund_requested_at?: string | null
          refunded_at?: string | null
          rejection_reason?: string | null
          requested_amount: number
          requested_at?: string
          return_carrier?: string | null
          return_tracking_no?: string | null
          reviewed_at?: string | null
          status?: string
          store_note?: string | null
          type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          after_sale_no?: string
          approved_amount?: number | null
          assigned_to?: string | null
          closed_at?: string | null
          created_at?: string
          evidence_urls?: Json
          id?: string
          inspected_at?: string | null
          location_id?: string
          order_id?: string
          order_item_id?: string
          reason_code?: string
          reason_text?: string | null
          received_at?: string | null
          refund_requested_at?: string | null
          refunded_at?: string | null
          rejection_reason?: string | null
          requested_amount?: number
          requested_at?: string
          return_carrier?: string | null
          return_tracking_no?: string | null
          reviewed_at?: string | null
          status?: string
          store_note?: string | null
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "commerce_after_sales_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_after_sales_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "commerce_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_after_sales_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "commerce_order_items"
            referencedColumns: ["id"]
          },
        ]
      }
      commerce_customer_identities: {
        Row: {
          created_at: string
          customer_id: string
          id: string
          provider: string
          provider_subject: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          id?: string
          provider: string
          provider_subject: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          id?: string
          provider?: string
          provider_subject?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "commerce_customer_identities_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "commerce_customers"
            referencedColumns: ["id"]
          },
        ]
      }
      commerce_customers: {
        Row: {
          avatar_url: string | null
          created_at: string
          external_subject: string
          id: string
          last_login_at: string | null
          nickname: string | null
          phone: string | null
          status: string
          updated_at: string
          wechat_openid: string | null
          wechat_unionid: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          external_subject: string
          id?: string
          last_login_at?: string | null
          nickname?: string | null
          phone?: string | null
          status?: string
          updated_at?: string
          wechat_openid?: string | null
          wechat_unionid?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          external_subject?: string
          id?: string
          last_login_at?: string | null
          nickname?: string | null
          phone?: string | null
          status?: string
          updated_at?: string
          wechat_openid?: string | null
          wechat_unionid?: string | null
        }
        Relationships: []
      }
      commerce_listings: {
        Row: {
          category: string | null
          compare_at_price: number | null
          condition_grade: string | null
          cover_url: string | null
          created_at: string
          created_by: string | null
          description: string | null
          epc: string | null
          id: string
          image_urls: Json
          location_id: string
          price: number
          product_type: string
          published_at: string | null
          sku_id: string
          sold_at: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          category?: string | null
          compare_at_price?: number | null
          condition_grade?: string | null
          cover_url?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          epc?: string | null
          id?: string
          image_urls?: Json
          location_id: string
          price: number
          product_type?: string
          published_at?: string | null
          sku_id: string
          sold_at?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          category?: string | null
          compare_at_price?: number | null
          condition_grade?: string | null
          cover_url?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          epc?: string | null
          id?: string
          image_urls?: Json
          location_id?: string
          price?: number
          product_type?: string
          published_at?: string | null
          sku_id?: string
          sold_at?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "commerce_listings_epc_fkey"
            columns: ["epc"]
            isOneToOne: false
            referencedRelation: "inv_epcs"
            referencedColumns: ["epc"]
          },
          {
            foreignKeyName: "commerce_listings_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_listings_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      commerce_order_items: {
        Row: {
          category_code: string | null
          category_name_snapshot: string | null
          condition_snapshot: string | null
          created_at: string
          discount_snapshot: Json
          discount_total: number
          epc: string | null
          id: string
          image_snapshot: string | null
          line_total: number
          listing_id: string | null
          location_id: string
          order_id: string
          original_unit_price: number | null
          ownership_snapshot: string | null
          quantity: number
          settlement_snapshot: Json | null
          settlement_subject_id: string | null
          sku_id: string
          subcategory_code: string | null
          subcategory_name_snapshot: string | null
          title_snapshot: string
          unit_price: number
        }
        Insert: {
          category_code?: string | null
          category_name_snapshot?: string | null
          condition_snapshot?: string | null
          created_at?: string
          discount_snapshot?: Json
          discount_total?: number
          epc?: string | null
          id?: string
          image_snapshot?: string | null
          line_total: number
          listing_id?: string | null
          location_id: string
          order_id: string
          original_unit_price?: number | null
          ownership_snapshot?: string | null
          quantity?: number
          settlement_snapshot?: Json | null
          settlement_subject_id?: string | null
          sku_id: string
          subcategory_code?: string | null
          subcategory_name_snapshot?: string | null
          title_snapshot: string
          unit_price: number
        }
        Update: {
          category_code?: string | null
          category_name_snapshot?: string | null
          condition_snapshot?: string | null
          created_at?: string
          discount_snapshot?: Json
          discount_total?: number
          epc?: string | null
          id?: string
          image_snapshot?: string | null
          line_total?: number
          listing_id?: string | null
          location_id?: string
          order_id?: string
          original_unit_price?: number | null
          ownership_snapshot?: string | null
          quantity?: number
          settlement_snapshot?: Json | null
          settlement_subject_id?: string | null
          sku_id?: string
          subcategory_code?: string | null
          subcategory_name_snapshot?: string | null
          title_snapshot?: string
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "commerce_order_items_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "commerce_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_order_items_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "commerce_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_order_items_settlement_subject_id_fkey"
            columns: ["settlement_subject_id"]
            isOneToOne: false
            referencedRelation: "payment_subjects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      commerce_orders: {
        Row: {
          authorization_id: string | null
          benefit_snapshot: Json
          cancelled_at: string | null
          completed_at: string | null
          courier_provider: string | null
          courier_quote_snapshot: Json | null
          courier_service_code: string | null
          courier_service_name: string | null
          created_at: string
          currency: string
          customer_id: string | null
          customer_note: string | null
          discount_snapshot: Json
          discount_total: number
          fulfillment_method: string
          id: string
          idempotency_key: string
          metadata: Json
          operator_id: string | null
          order_no: string
          order_status: string
          paid_at: string | null
          payment_status: string
          pos_shift_id: string | null
          provider_transaction_id: string | null
          recipient_name: string | null
          recipient_phone: string | null
          reservation_expires_at: string
          sale_location_id: string | null
          shipping_address: Json | null
          shipping_fee: number
          source_channel: string
          subtotal: number
          total_amount: number
          updated_at: string
          user_id: string | null
        }
        Insert: {
          authorization_id?: string | null
          benefit_snapshot?: Json
          cancelled_at?: string | null
          completed_at?: string | null
          courier_provider?: string | null
          courier_quote_snapshot?: Json | null
          courier_service_code?: string | null
          courier_service_name?: string | null
          created_at?: string
          currency?: string
          customer_id?: string | null
          customer_note?: string | null
          discount_snapshot?: Json
          discount_total?: number
          fulfillment_method?: string
          id?: string
          idempotency_key: string
          metadata?: Json
          operator_id?: string | null
          order_no?: string
          order_status?: string
          paid_at?: string | null
          payment_status?: string
          pos_shift_id?: string | null
          provider_transaction_id?: string | null
          recipient_name?: string | null
          recipient_phone?: string | null
          reservation_expires_at: string
          sale_location_id?: string | null
          shipping_address?: Json | null
          shipping_fee?: number
          source_channel?: string
          subtotal?: number
          total_amount?: number
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          authorization_id?: string | null
          benefit_snapshot?: Json
          cancelled_at?: string | null
          completed_at?: string | null
          courier_provider?: string | null
          courier_quote_snapshot?: Json | null
          courier_service_code?: string | null
          courier_service_name?: string | null
          created_at?: string
          currency?: string
          customer_id?: string | null
          customer_note?: string | null
          discount_snapshot?: Json
          discount_total?: number
          fulfillment_method?: string
          id?: string
          idempotency_key?: string
          metadata?: Json
          operator_id?: string | null
          order_no?: string
          order_status?: string
          paid_at?: string | null
          payment_status?: string
          pos_shift_id?: string | null
          provider_transaction_id?: string | null
          recipient_name?: string | null
          recipient_phone?: string | null
          reservation_expires_at?: string
          sale_location_id?: string | null
          shipping_address?: Json | null
          shipping_fee?: number
          source_channel?: string
          subtotal?: number
          total_amount?: number
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "commerce_orders_authorization_id_fkey"
            columns: ["authorization_id"]
            isOneToOne: false
            referencedRelation: "pos_authorizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "commerce_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_orders_pos_shift_id_fkey"
            columns: ["pos_shift_id"]
            isOneToOne: false
            referencedRelation: "pos_shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_orders_sale_location_id_fkey"
            columns: ["sale_location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      commerce_payment_events: {
        Row: {
          error: string | null
          event_type: string
          id: string
          payload: Json
          payment_id: string | null
          processed_at: string | null
          processing_status: string
          provider: string
          provider_event_id: string | null
          received_at: string
          signature_verified: boolean
        }
        Insert: {
          error?: string | null
          event_type: string
          id?: string
          payload?: Json
          payment_id?: string | null
          processed_at?: string | null
          processing_status?: string
          provider: string
          provider_event_id?: string | null
          received_at?: string
          signature_verified?: boolean
        }
        Update: {
          error?: string | null
          event_type?: string
          id?: string
          payload?: Json
          payment_id?: string | null
          processed_at?: string | null
          processing_status?: string
          provider?: string
          provider_event_id?: string | null
          received_at?: string
          signature_verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "commerce_payment_events_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "commerce_payments"
            referencedColumns: ["id"]
          },
        ]
      }
      commerce_payment_suborders: {
        Row: {
          allocation_snapshot: Json
          amount: number
          created_at: string
          currency: string
          id: string
          line_amount: number
          merchant_id_snapshot: string
          order_adjustment: number
          order_id: string
          payment_code_snapshot: string
          payment_id: string
          payment_profile_id: string
          provider: string
          provider_suborder_id: string | null
          settlement_subject_id: string
          status: string
          updated_at: string
        }
        Insert: {
          allocation_snapshot?: Json
          amount: number
          created_at?: string
          currency?: string
          id?: string
          line_amount: number
          merchant_id_snapshot: string
          order_adjustment?: number
          order_id: string
          payment_code_snapshot: string
          payment_id: string
          payment_profile_id: string
          provider?: string
          provider_suborder_id?: string | null
          settlement_subject_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          allocation_snapshot?: Json
          amount?: number
          created_at?: string
          currency?: string
          id?: string
          line_amount?: number
          merchant_id_snapshot?: string
          order_adjustment?: number
          order_id?: string
          payment_code_snapshot?: string
          payment_id?: string
          payment_profile_id?: string
          provider?: string
          provider_suborder_id?: string | null
          settlement_subject_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "commerce_payment_suborders_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "commerce_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_payment_suborders_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "commerce_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_payment_suborders_payment_profile_id_fkey"
            columns: ["payment_profile_id"]
            isOneToOne: false
            referencedRelation: "store_payment_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_payment_suborders_settlement_subject_id_fkey"
            columns: ["settlement_subject_id"]
            isOneToOne: false
            referencedRelation: "payment_subjects"
            referencedColumns: ["id"]
          },
        ]
      }
      commerce_payments: {
        Row: {
          amount: number
          created_at: string
          currency: string
          expires_at: string | null
          failure_code: string | null
          failure_message: string | null
          id: string
          idempotency_key: string
          merchant_snapshot: Json
          order_id: string
          paid_at: string | null
          payment_payload: Json
          payment_profile_id: string | null
          provider: string
          provider_transaction_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          expires_at?: string | null
          failure_code?: string | null
          failure_message?: string | null
          id?: string
          idempotency_key: string
          merchant_snapshot?: Json
          order_id: string
          paid_at?: string | null
          payment_payload?: Json
          payment_profile_id?: string | null
          provider: string
          provider_transaction_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          expires_at?: string | null
          failure_code?: string | null
          failure_message?: string | null
          id?: string
          idempotency_key?: string
          merchant_snapshot?: Json
          order_id?: string
          paid_at?: string | null
          payment_payload?: Json
          payment_profile_id?: string | null
          provider?: string
          provider_transaction_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "commerce_payments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "commerce_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_payments_payment_profile_id_fkey"
            columns: ["payment_profile_id"]
            isOneToOne: false
            referencedRelation: "store_payment_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      commerce_refunds: {
        Row: {
          after_sale_id: string | null
          amount: number
          created_at: string
          failure_message: string | null
          id: string
          idempotency_key: string
          order_id: string
          payment_id: string
          provider: string
          provider_refund_id: string | null
          reason: string | null
          refunded_at: string | null
          requested_at: string
          requested_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          after_sale_id?: string | null
          amount: number
          created_at?: string
          failure_message?: string | null
          id?: string
          idempotency_key: string
          order_id: string
          payment_id: string
          provider: string
          provider_refund_id?: string | null
          reason?: string | null
          refunded_at?: string | null
          requested_at?: string
          requested_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          after_sale_id?: string | null
          amount?: number
          created_at?: string
          failure_message?: string | null
          id?: string
          idempotency_key?: string
          order_id?: string
          payment_id?: string
          provider?: string
          provider_refund_id?: string | null
          reason?: string | null
          refunded_at?: string | null
          requested_at?: string
          requested_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "commerce_refunds_after_sale_id_fkey"
            columns: ["after_sale_id"]
            isOneToOne: false
            referencedRelation: "commerce_after_sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_refunds_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "commerce_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commerce_refunds_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "commerce_payments"
            referencedColumns: ["id"]
          },
        ]
      }
      domestic_bulk_order_lines: {
        Row: {
          created_at: string
          id: string
          item_title: string | null
          notes: string | null
          order_id: string
          position: number
          qty: number
          subtotal_cny: number | null
          unit_price_cny: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          item_title?: string | null
          notes?: string | null
          order_id: string
          position?: number
          qty?: number
          subtotal_cny?: number | null
          unit_price_cny?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          item_title?: string | null
          notes?: string | null
          order_id?: string
          position?: number
          qty?: number
          subtotal_cny?: number | null
          unit_price_cny?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "domestic_bulk_order_lines_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "domestic_bulk_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      domestic_bulk_orders: {
        Row: {
          attachment_urls: Json
          carrier: string | null
          completeness: number
          contract_no: string | null
          created_at: string
          deleted_at: string | null
          delivered_at: string | null
          id: string
          invoice_no: string | null
          notes: string | null
          pay_method: string | null
          purchased_at: string | null
          raw_payload: Json | null
          receiver_address: string | null
          receiver_name: string | null
          receiver_phone: string | null
          shipping_cny: number | null
          source_order_no: string | null
          status: string
          supplier_contact: string | null
          supplier_name: string | null
          total_cny: number | null
          tracking_no: string | null
          updated_at: string
        }
        Insert: {
          attachment_urls?: Json
          carrier?: string | null
          completeness?: number
          contract_no?: string | null
          created_at?: string
          deleted_at?: string | null
          delivered_at?: string | null
          id?: string
          invoice_no?: string | null
          notes?: string | null
          pay_method?: string | null
          purchased_at?: string | null
          raw_payload?: Json | null
          receiver_address?: string | null
          receiver_name?: string | null
          receiver_phone?: string | null
          shipping_cny?: number | null
          source_order_no?: string | null
          status?: string
          supplier_contact?: string | null
          supplier_name?: string | null
          total_cny?: number | null
          tracking_no?: string | null
          updated_at?: string
        }
        Update: {
          attachment_urls?: Json
          carrier?: string | null
          completeness?: number
          contract_no?: string | null
          created_at?: string
          deleted_at?: string | null
          delivered_at?: string | null
          id?: string
          invoice_no?: string | null
          notes?: string | null
          pay_method?: string | null
          purchased_at?: string | null
          raw_payload?: Json | null
          receiver_address?: string | null
          receiver_name?: string | null
          receiver_phone?: string | null
          shipping_cny?: number | null
          source_order_no?: string | null
          status?: string
          supplier_contact?: string | null
          supplier_name?: string | null
          total_cny?: number | null
          tracking_no?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      domestic_orders: {
        Row: {
          carrier: string | null
          chat_summary: string | null
          completeness: number
          created_at: string
          deleted_at: string | null
          id: string
          item_image_url: string | null
          item_title: string | null
          notes: string | null
          platform: string
          price_cny: number | null
          purchased_at: string | null
          qty: number | null
          raw_payload: Json | null
          receiver_address: string | null
          receiver_name: string | null
          receiver_phone: string | null
          screenshot_urls: Json | null
          seller_handle: string | null
          seller_name: string | null
          shipping_cny: number | null
          source_order_no: string | null
          status: string
          total_cny: number | null
          tracking_no: string | null
          updated_at: string
        }
        Insert: {
          carrier?: string | null
          chat_summary?: string | null
          completeness?: number
          created_at?: string
          deleted_at?: string | null
          id?: string
          item_image_url?: string | null
          item_title?: string | null
          notes?: string | null
          platform: string
          price_cny?: number | null
          purchased_at?: string | null
          qty?: number | null
          raw_payload?: Json | null
          receiver_address?: string | null
          receiver_name?: string | null
          receiver_phone?: string | null
          screenshot_urls?: Json | null
          seller_handle?: string | null
          seller_name?: string | null
          shipping_cny?: number | null
          source_order_no?: string | null
          status?: string
          total_cny?: number | null
          tracking_no?: string | null
          updated_at?: string
        }
        Update: {
          carrier?: string | null
          chat_summary?: string | null
          completeness?: number
          created_at?: string
          deleted_at?: string | null
          id?: string
          item_image_url?: string | null
          item_title?: string | null
          notes?: string | null
          platform?: string
          price_cny?: number | null
          purchased_at?: string | null
          qty?: number | null
          raw_payload?: Json | null
          receiver_address?: string | null
          receiver_name?: string | null
          receiver_phone?: string | null
          screenshot_urls?: Json | null
          seller_handle?: string | null
          seller_name?: string | null
          shipping_cny?: number | null
          source_order_no?: string | null
          status?: string
          total_cny?: number | null
          tracking_no?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      editorial_content_channels: {
        Row: {
          group_name: string
          id: string
          is_active: boolean
          name: string
          sort_order: number
        }
        Insert: {
          group_name?: string
          id: string
          is_active?: boolean
          name: string
          sort_order?: number
        }
        Update: {
          group_name?: string
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      editorial_content_comments: {
        Row: {
          author_name: string
          body: string
          content_id: string
          created_at: string
          id: string
          status: string
          user_id: string | null
        }
        Insert: {
          author_name?: string
          body: string
          content_id: string
          created_at?: string
          id?: string
          status?: string
          user_id?: string | null
        }
        Update: {
          author_name?: string
          body?: string
          content_id?: string
          created_at?: string
          id?: string
          status?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "editorial_content_comments_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "editorial_contents"
            referencedColumns: ["id"]
          },
        ]
      }
      editorial_content_engagement: {
        Row: {
          bookmark_count: number
          comment_count: number
          content_id: string
          like_count: number
          share_count: number
          updated_at: string
        }
        Insert: {
          bookmark_count?: number
          comment_count?: number
          content_id: string
          like_count?: number
          share_count?: number
          updated_at?: string
        }
        Update: {
          bookmark_count?: number
          comment_count?: number
          content_id?: string
          like_count?: number
          share_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "editorial_content_engagement_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: true
            referencedRelation: "editorial_contents"
            referencedColumns: ["id"]
          },
        ]
      }
      editorial_content_relations: {
        Row: {
          content_id: string
          created_at: string
          entity_key: string
          entity_type: string
          id: string
          label: string
        }
        Insert: {
          content_id: string
          created_at?: string
          entity_key: string
          entity_type: string
          id?: string
          label: string
        }
        Update: {
          content_id?: string
          created_at?: string
          entity_key?: string
          entity_type?: string
          id?: string
          label?: string
        }
        Relationships: [
          {
            foreignKeyName: "editorial_content_relations_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "editorial_contents"
            referencedColumns: ["id"]
          },
        ]
      }
      editorial_content_user_actions: {
        Row: {
          action: string
          content_id: string
          created_at: string
          user_key: string
        }
        Insert: {
          action: string
          content_id: string
          created_at?: string
          user_key: string
        }
        Update: {
          action?: string
          content_id?: string
          created_at?: string
          user_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "editorial_content_user_actions_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "editorial_contents"
            referencedColumns: ["id"]
          },
        ]
      }
      editorial_contents: {
        Row: {
          aspect_ratio: number
          body: string | null
          channel_ids: string[]
          cover_url: string | null
          created_at: string
          created_by: string | null
          duration_seconds: number
          id: string
          keywords: string[]
          published_at: string | null
          related_knowledge_ids: string[]
          related_product_ids: string[]
          reviewed_by: string | null
          scheduled_at: string | null
          slug: string
          source: Json
          status: Database["public"]["Enums"]["editorial_content_status"]
          summary: string
          title: string
          type: Database["public"]["Enums"]["editorial_content_type"]
          updated_at: string
          video_url: string | null
        }
        Insert: {
          aspect_ratio?: number
          body?: string | null
          channel_ids?: string[]
          cover_url?: string | null
          created_at?: string
          created_by?: string | null
          duration_seconds?: number
          id?: string
          keywords?: string[]
          published_at?: string | null
          related_knowledge_ids?: string[]
          related_product_ids?: string[]
          reviewed_by?: string | null
          scheduled_at?: string | null
          slug: string
          source?: Json
          status?: Database["public"]["Enums"]["editorial_content_status"]
          summary: string
          title: string
          type: Database["public"]["Enums"]["editorial_content_type"]
          updated_at?: string
          video_url?: string | null
        }
        Update: {
          aspect_ratio?: number
          body?: string | null
          channel_ids?: string[]
          cover_url?: string | null
          created_at?: string
          created_by?: string | null
          duration_seconds?: number
          id?: string
          keywords?: string[]
          published_at?: string | null
          related_knowledge_ids?: string[]
          related_product_ids?: string[]
          reviewed_by?: string | null
          scheduled_at?: string | null
          slug?: string
          source?: Json
          status?: Database["public"]["Enums"]["editorial_content_status"]
          summary?: string
          title?: string
          type?: Database["public"]["Enums"]["editorial_content_type"]
          updated_at?: string
          video_url?: string | null
        }
        Relationships: []
      }
      fulfillment_exceptions: {
        Row: {
          created_at: string
          description: string | null
          evidence_urls: Json
          fulfillment_id: string
          fulfillment_item_id: string | null
          id: string
          kind: string
          reported_by: string | null
          resolution: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          evidence_urls?: Json
          fulfillment_id: string
          fulfillment_item_id?: string | null
          id?: string
          kind: string
          reported_by?: string | null
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          evidence_urls?: Json
          fulfillment_id?: string
          fulfillment_item_id?: string | null
          id?: string
          kind?: string
          reported_by?: string | null
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "fulfillment_exceptions_fulfillment_id_fkey"
            columns: ["fulfillment_id"]
            isOneToOne: false
            referencedRelation: "fulfillments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillment_exceptions_fulfillment_item_id_fkey"
            columns: ["fulfillment_item_id"]
            isOneToOne: false
            referencedRelation: "fulfillment_items"
            referencedColumns: ["id"]
          },
        ]
      }
      fulfillment_items: {
        Row: {
          epc: string | null
          expected_qty: number
          fulfillment_id: string
          id: string
          order_item_id: string
          packed_at: string | null
          packed_qty: number
          picked_at: string | null
          picked_qty: number
          sku_id: string
        }
        Insert: {
          epc?: string | null
          expected_qty?: number
          fulfillment_id: string
          id?: string
          order_item_id: string
          packed_at?: string | null
          packed_qty?: number
          picked_at?: string | null
          picked_qty?: number
          sku_id: string
        }
        Update: {
          epc?: string | null
          expected_qty?: number
          fulfillment_id?: string
          id?: string
          order_item_id?: string
          packed_at?: string | null
          packed_qty?: number
          picked_at?: string | null
          picked_qty?: number
          sku_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fulfillment_items_fulfillment_id_fkey"
            columns: ["fulfillment_id"]
            isOneToOne: false
            referencedRelation: "fulfillments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillment_items_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "commerce_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillment_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      fulfillment_scans: {
        Row: {
          client_op_id: string | null
          code: string
          code_type: string
          created_at: string
          device_id: string | null
          fulfillment_id: string
          fulfillment_item_id: string | null
          id: string
          operator_id: string | null
          phase: string
          rejection_reason: string | null
          result: string
        }
        Insert: {
          client_op_id?: string | null
          code: string
          code_type: string
          created_at?: string
          device_id?: string | null
          fulfillment_id: string
          fulfillment_item_id?: string | null
          id?: string
          operator_id?: string | null
          phase: string
          rejection_reason?: string | null
          result: string
        }
        Update: {
          client_op_id?: string | null
          code?: string
          code_type?: string
          created_at?: string
          device_id?: string | null
          fulfillment_id?: string
          fulfillment_item_id?: string | null
          id?: string
          operator_id?: string | null
          phase?: string
          rejection_reason?: string | null
          result?: string
        }
        Relationships: [
          {
            foreignKeyName: "fulfillment_scans_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "inv_handheld_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillment_scans_fulfillment_id_fkey"
            columns: ["fulfillment_id"]
            isOneToOne: false
            referencedRelation: "fulfillments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillment_scans_fulfillment_item_id_fkey"
            columns: ["fulfillment_item_id"]
            isOneToOne: false
            referencedRelation: "fulfillment_items"
            referencedColumns: ["id"]
          },
        ]
      }
      fulfillments: {
        Row: {
          claimed_at: string | null
          claimed_by: string | null
          claimed_device_id: string | null
          code: string
          created_at: string
          handed_over_at: string | null
          id: string
          location_id: string
          order_id: string
          packed_at: string | null
          packing_started_at: string | null
          picked_at: string | null
          picking_started_at: string | null
          priority: number
          status: string
          tote_id: string | null
          updated_at: string
        }
        Insert: {
          claimed_at?: string | null
          claimed_by?: string | null
          claimed_device_id?: string | null
          code?: string
          created_at?: string
          handed_over_at?: string | null
          id?: string
          location_id: string
          order_id: string
          packed_at?: string | null
          packing_started_at?: string | null
          picked_at?: string | null
          picking_started_at?: string | null
          priority?: number
          status?: string
          tote_id?: string | null
          updated_at?: string
        }
        Update: {
          claimed_at?: string | null
          claimed_by?: string | null
          claimed_device_id?: string | null
          code?: string
          created_at?: string
          handed_over_at?: string | null
          id?: string
          location_id?: string
          order_id?: string
          packed_at?: string | null
          packing_started_at?: string | null
          picked_at?: string | null
          picking_started_at?: string | null
          priority?: number
          status?: string
          tote_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fulfillments_claimed_device_id_fkey"
            columns: ["claimed_device_id"]
            isOneToOne: false
            referencedRelation: "inv_handheld_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillments_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "commerce_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillments_tote_fk"
            columns: ["tote_id"]
            isOneToOne: false
            referencedRelation: "warehouse_totes"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_api_probes: {
        Row: {
          capability_key: string
          error: string | null
          gw_code: number | null
          http_status: number | null
          id: string
          latency_ms: number | null
          method: string
          ok: boolean
          platform: string
          request_params: Json | null
          response_snippet: string | null
          shop_id: string | null
          tested_at: string
          tested_by: string | null
          trace_id: string | null
          version: string
        }
        Insert: {
          capability_key: string
          error?: string | null
          gw_code?: number | null
          http_status?: number | null
          id?: string
          latency_ms?: number | null
          method: string
          ok?: boolean
          platform: string
          request_params?: Json | null
          response_snippet?: string | null
          shop_id?: string | null
          tested_at?: string
          tested_by?: string | null
          trace_id?: string | null
          version: string
        }
        Update: {
          capability_key?: string
          error?: string | null
          gw_code?: number | null
          http_status?: number | null
          id?: string
          latency_ms?: number | null
          method?: string
          ok?: boolean
          platform?: string
          request_params?: Json | null
          response_snippet?: string | null
          shop_id?: string | null
          tested_at?: string
          tested_by?: string | null
          trace_id?: string | null
          version?: string
        }
        Relationships: []
      }
      integration_api_registry: {
        Row: {
          capability_key: string
          capability_name: string
          created_at: string
          doc_url: string | null
          http_verb: string
          id: string
          is_overridden: boolean
          method: string
          note: string | null
          platform: string
          requirement: string
          scope: string
          sort_order: number
          token_scope: string
          updated_at: string
          updated_by: string | null
          version: string
        }
        Insert: {
          capability_key: string
          capability_name: string
          created_at?: string
          doc_url?: string | null
          http_verb?: string
          id?: string
          is_overridden?: boolean
          method: string
          note?: string | null
          platform: string
          requirement: string
          scope: string
          sort_order?: number
          token_scope?: string
          updated_at?: string
          updated_by?: string | null
          version: string
        }
        Update: {
          capability_key?: string
          capability_name?: string
          created_at?: string
          doc_url?: string | null
          http_verb?: string
          id?: string
          is_overridden?: boolean
          method?: string
          note?: string | null
          platform?: string
          requirement?: string
          scope?: string
          sort_order?: number
          token_scope?: string
          updated_at?: string
          updated_by?: string | null
          version?: string
        }
        Relationships: []
      }
      inv_brands: {
        Row: {
          aliases: string[]
          category_codes: string[]
          created_at: string
          entity_type: string
          id: string
          logo_url: string | null
          name: string
          name_original: string | null
          normalized_name: string
          notes: string | null
          origin_country: string | null
          origin_region: string | null
          status: string
          updated_at: string
        }
        Insert: {
          aliases?: string[]
          category_codes?: string[]
          created_at?: string
          entity_type?: string
          id?: string
          logo_url?: string | null
          name: string
          name_original?: string | null
          normalized_name: string
          notes?: string | null
          origin_country?: string | null
          origin_region?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          aliases?: string[]
          category_codes?: string[]
          created_at?: string
          entity_type?: string
          id?: string
          logo_url?: string | null
          name?: string
          name_original?: string | null
          normalized_name?: string
          notes?: string | null
          origin_country?: string | null
          origin_region?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      inv_categories: {
        Row: {
          code: string
          created_at: string
          id: string
          is_active: boolean
          is_system: boolean
          kind: string
          name: string
          parent_id: string | null
          sort_order: number
          updated_at: string
          youzan_hq_category_id: number | null
          youzan_hq_parent_id: number | null
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_system?: boolean
          kind?: string
          name: string
          parent_id?: string | null
          sort_order?: number
          updated_at?: string
          youzan_hq_category_id?: number | null
          youzan_hq_parent_id?: number | null
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_system?: boolean
          kind?: string
          name?: string
          parent_id?: string | null
          sort_order?: number
          updated_at?: string
          youzan_hq_category_id?: number | null
          youzan_hq_parent_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inv_categories_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "inv_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_epcs: {
        Row: {
          current_location_id: string | null
          epc: string
          first_seen_at: string
          label_batch_id: string | null
          last_seen_at: string
          sku_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          current_location_id?: string | null
          epc: string
          first_seen_at?: string
          label_batch_id?: string | null
          last_seen_at?: string
          sku_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          current_location_id?: string | null
          epc?: string
          first_seen_at?: string
          label_batch_id?: string | null
          last_seen_at?: string
          sku_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inv_epcs_current_location_id_fkey"
            columns: ["current_location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inv_epcs_label_batch_id_fkey"
            columns: ["label_batch_id"]
            isOneToOne: false
            referencedRelation: "inv_label_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inv_epcs_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_facets: {
        Row: {
          aliases: string[]
          category_codes: string[]
          code: string
          created_at: string
          dimension: string
          id: string
          is_active: boolean
          is_system: boolean
          name: string
          parent_id: string | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          aliases?: string[]
          category_codes?: string[]
          code: string
          created_at?: string
          dimension: string
          id?: string
          is_active?: boolean
          is_system?: boolean
          name: string
          parent_id?: string | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          aliases?: string[]
          category_codes?: string[]
          code?: string
          created_at?: string
          dimension?: string
          id?: string
          is_active?: boolean
          is_system?: boolean
          name?: string
          parent_id?: string | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inv_facets_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "inv_facets"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_handheld_devices: {
        Row: {
          app_version: string | null
          capabilities: Json
          created_at: string
          default_location_id: string | null
          device_code: string
          id: string
          install_id: string | null
          is_active: boolean
          label: string
          last_seen_at: string | null
          os_version: string | null
          owner_user_id: string | null
          token: string
          updated_at: string
        }
        Insert: {
          app_version?: string | null
          capabilities?: Json
          created_at?: string
          default_location_id?: string | null
          device_code: string
          id?: string
          install_id?: string | null
          is_active?: boolean
          label: string
          last_seen_at?: string | null
          os_version?: string | null
          owner_user_id?: string | null
          token: string
          updated_at?: string
        }
        Update: {
          app_version?: string | null
          capabilities?: Json
          created_at?: string
          default_location_id?: string | null
          device_code?: string
          id?: string
          install_id?: string | null
          is_active?: boolean
          label?: string
          last_seen_at?: string | null
          os_version?: string | null
          owner_user_id?: string | null
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inv_handheld_devices_default_location_id_fkey"
            columns: ["default_location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_handheld_diag: {
        Row: {
          app_version: string | null
          created_at: string
          device_id: string | null
          id: string
          kind: string
          message: string
          os_version: string | null
          payload: Json
          user_id: string | null
        }
        Insert: {
          app_version?: string | null
          created_at?: string
          device_id?: string | null
          id?: string
          kind: string
          message: string
          os_version?: string | null
          payload?: Json
          user_id?: string | null
        }
        Update: {
          app_version?: string | null
          created_at?: string
          device_id?: string | null
          id?: string
          kind?: string
          message?: string
          os_version?: string | null
          payload?: Json
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inv_handheld_diag_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "inv_handheld_devices"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_handheld_notifications: {
        Row: {
          device_id: string | null
          id: string
          kind: string
          location_id: string | null
          payload: Json
          title: string | null
          ts: string
        }
        Insert: {
          device_id?: string | null
          id?: string
          kind: string
          location_id?: string | null
          payload?: Json
          title?: string | null
          ts?: string
        }
        Update: {
          device_id?: string | null
          id?: string
          kind?: string
          location_id?: string | null
          payload?: Json
          title?: string | null
          ts?: string
        }
        Relationships: [
          {
            foreignKeyName: "inv_handheld_notifications_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "inv_handheld_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inv_handheld_notifications_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_handheld_op_log: {
        Row: {
          client_op_id: string
          created_at: string
          device_id: string
          id: string
          op_type: string
          request_hash: string | null
          response_json: Json | null
          response_status: number
        }
        Insert: {
          client_op_id: string
          created_at?: string
          device_id: string
          id?: string
          op_type: string
          request_hash?: string | null
          response_json?: Json | null
          response_status?: number
        }
        Update: {
          client_op_id?: string
          created_at?: string
          device_id?: string
          id?: string
          op_type?: string
          request_hash?: string | null
          response_json?: Json | null
          response_status?: number
        }
        Relationships: [
          {
            foreignKeyName: "inv_handheld_op_log_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "inv_handheld_devices"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_inbound_lines: {
        Row: {
          created_at: string
          id: string
          order_id: string
          qty: number
          sku_id: string
          subtotal: number
          unit_price: number
        }
        Insert: {
          created_at?: string
          id?: string
          order_id: string
          qty: number
          sku_id: string
          subtotal?: number
          unit_price?: number
        }
        Update: {
          created_at?: string
          id?: string
          order_id?: string
          qty?: number
          sku_id?: string
          subtotal?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "inv_inbound_lines_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "inv_inbound_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inv_inbound_lines_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_inbound_orders: {
        Row: {
          created_at: string
          device_id: string | null
          id: string
          location_id: string | null
          notes: string | null
          operator: string | null
          scanned_at: string
          source: string | null
          total_qty: number
          total_value_cny: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          device_id?: string | null
          id?: string
          location_id?: string | null
          notes?: string | null
          operator?: string | null
          scanned_at?: string
          source?: string | null
          total_qty?: number
          total_value_cny?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          device_id?: string | null
          id?: string
          location_id?: string | null
          notes?: string | null
          operator?: string | null
          scanned_at?: string
          source?: string | null
          total_qty?: number
          total_value_cny?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inv_inbound_orders_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "inv_handheld_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inv_inbound_orders_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_label_batches: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          operator: string | null
          parcel_item_id: string | null
          printed_at: string
          qty: number
          sku_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          operator?: string | null
          parcel_item_id?: string | null
          printed_at?: string
          qty: number
          sku_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          operator?: string | null
          parcel_item_id?: string | null
          printed_at?: string
          qty?: number
          sku_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inv_label_batches_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_label_templates: {
        Row: {
          created_at: string
          created_by: string | null
          elements: Json
          height_mm: number
          id: string
          is_default: boolean
          name: string
          print_type: string
          updated_at: string
          updated_by: string | null
          version: number
          width_mm: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          elements?: Json
          height_mm?: number
          id?: string
          is_default?: boolean
          name: string
          print_type?: string
          updated_at?: string
          updated_by?: string | null
          version?: number
          width_mm?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          elements?: Json
          height_mm?: number
          id?: string
          is_default?: boolean
          name?: string
          print_type?: string
          updated_at?: string
          updated_by?: string | null
          version?: number
          width_mm?: number
        }
        Relationships: []
      }
      inv_locations: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          kind: string
          name: string
          notes: string | null
          shop_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          kind: string
          name: string
          notes?: string | null
          shop_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          kind?: string
          name?: string
          notes?: string | null
          shop_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inv_locations_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: true
            referencedRelation: "youzan_shops"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_sku_classifications: {
        Row: {
          alternative_categories: Json
          attribute_confidence: Json
          attributes: Json
          brand_candidate_text: string | null
          brand_id: string | null
          category_code: string
          clarification_requests: Json
          confidence: number | null
          corrected_at: string | null
          corrected_by: string | null
          corrected_category_code: string | null
          created_at: string
          created_by: string | null
          evidence: Json
          facet_predictions: Json
          id: string
          image_count: number
          model: string
          normalized_result: Json
          predicted_category_code: string | null
          prompt_version: string
          raw_result: Json
          sku_id: string | null
          source: string
          status: string
          taxonomy_version: string
          unmatched_facets: Json
          updated_at: string
          warning: string | null
        }
        Insert: {
          alternative_categories?: Json
          attribute_confidence?: Json
          attributes?: Json
          brand_candidate_text?: string | null
          brand_id?: string | null
          category_code: string
          clarification_requests?: Json
          confidence?: number | null
          corrected_at?: string | null
          corrected_by?: string | null
          corrected_category_code?: string | null
          created_at?: string
          created_by?: string | null
          evidence?: Json
          facet_predictions?: Json
          id?: string
          image_count?: number
          model: string
          normalized_result?: Json
          predicted_category_code?: string | null
          prompt_version: string
          raw_result?: Json
          sku_id?: string | null
          source?: string
          status?: string
          taxonomy_version: string
          unmatched_facets?: Json
          updated_at?: string
          warning?: string | null
        }
        Update: {
          alternative_categories?: Json
          attribute_confidence?: Json
          attributes?: Json
          brand_candidate_text?: string | null
          brand_id?: string | null
          category_code?: string
          clarification_requests?: Json
          confidence?: number | null
          corrected_at?: string | null
          corrected_by?: string | null
          corrected_category_code?: string | null
          created_at?: string
          created_by?: string | null
          evidence?: Json
          facet_predictions?: Json
          id?: string
          image_count?: number
          model?: string
          normalized_result?: Json
          predicted_category_code?: string | null
          prompt_version?: string
          raw_result?: Json
          sku_id?: string | null
          source?: string
          status?: string
          taxonomy_version?: string
          unmatched_facets?: Json
          updated_at?: string
          warning?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inv_sku_classifications_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "inv_brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inv_sku_classifications_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_sku_facets: {
        Row: {
          confidence: number | null
          created_at: string
          created_by: string | null
          facet_id: string
          sku_id: string
          source: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          facet_id: string
          sku_id: string
          source?: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          facet_id?: string
          sku_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "inv_sku_facets_facet_id_fkey"
            columns: ["facet_id"]
            isOneToOne: false
            referencedRelation: "inv_facets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inv_sku_facets_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_skus: {
        Row: {
          ai_suggested_price: number | null
          attribute_confidence: Json
          attributes: Json
          barcode: string | null
          brand_candidate_text: string | null
          brand_id: string | null
          bundle_items: Json
          category: string
          category_confidence: number | null
          category_source: string
          clarification_requests: Json
          classification_status: string
          created_at: string
          default_shop_ids: string[]
          discount_eligible: boolean
          epc: string
          grade: string | null
          id: string
          image_paths: string[]
          image_url: string | null
          inventory_policy: string
          inventory_version: number
          is_custom_price: boolean
          is_display: boolean
          keywords: string[]
          kind: string
          name: string
          notes: string | null
          pack_pieces: number | null
          price_tier: number
          recognition_request_id: string | null
          sale_ownership: string
          sales_state: string
          settlement_party_ref: string | null
          sku_code: string | null
          sku_scope: string
          status: string
          stock_qty: number
          updated_at: string
          weight_g: number | null
        }
        Insert: {
          ai_suggested_price?: number | null
          attribute_confidence?: Json
          attributes?: Json
          barcode?: string | null
          brand_candidate_text?: string | null
          brand_id?: string | null
          bundle_items?: Json
          category: string
          category_confidence?: number | null
          category_source?: string
          clarification_requests?: Json
          classification_status?: string
          created_at?: string
          default_shop_ids?: string[]
          discount_eligible?: boolean
          epc: string
          grade?: string | null
          id?: string
          image_paths?: string[]
          image_url?: string | null
          inventory_policy?: string
          inventory_version?: number
          is_custom_price?: boolean
          is_display?: boolean
          keywords?: string[]
          kind?: string
          name: string
          notes?: string | null
          pack_pieces?: number | null
          price_tier: number
          recognition_request_id?: string | null
          sale_ownership?: string
          sales_state?: string
          settlement_party_ref?: string | null
          sku_code?: string | null
          sku_scope?: string
          status?: string
          stock_qty?: number
          updated_at?: string
          weight_g?: number | null
        }
        Update: {
          ai_suggested_price?: number | null
          attribute_confidence?: Json
          attributes?: Json
          barcode?: string | null
          brand_candidate_text?: string | null
          brand_id?: string | null
          bundle_items?: Json
          category?: string
          category_confidence?: number | null
          category_source?: string
          clarification_requests?: Json
          classification_status?: string
          created_at?: string
          default_shop_ids?: string[]
          discount_eligible?: boolean
          epc?: string
          grade?: string | null
          id?: string
          image_paths?: string[]
          image_url?: string | null
          inventory_policy?: string
          inventory_version?: number
          is_custom_price?: boolean
          is_display?: boolean
          keywords?: string[]
          kind?: string
          name?: string
          notes?: string | null
          pack_pieces?: number | null
          price_tier?: number
          recognition_request_id?: string | null
          sale_ownership?: string
          sales_state?: string
          settlement_party_ref?: string | null
          sku_code?: string | null
          sku_scope?: string
          status?: string
          stock_qty?: number
          updated_at?: string
          weight_g?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inv_skus_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "inv_brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inv_skus_recognition_request_id_fkey"
            columns: ["recognition_request_id"]
            isOneToOne: false
            referencedRelation: "inv_sku_classifications"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_stock_movements: {
        Row: {
          balance_after: number
          created_at: string
          created_by: string | null
          delta: number
          epc: string | null
          id: string
          location_id: string
          note: string | null
          ref_id: string | null
          ref_type: string
          sku_id: string
        }
        Insert: {
          balance_after: number
          created_at?: string
          created_by?: string | null
          delta: number
          epc?: string | null
          id?: string
          location_id: string
          note?: string | null
          ref_id?: string | null
          ref_type: string
          sku_id: string
        }
        Update: {
          balance_after?: number
          created_at?: string
          created_by?: string | null
          delta?: number
          epc?: string | null
          id?: string
          location_id?: string
          note?: string | null
          ref_id?: string | null
          ref_type?: string
          sku_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inv_stock_movements_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inv_stock_movements_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_stocks: {
        Row: {
          location_id: string
          qty: number
          sku_id: string
          updated_at: string
        }
        Insert: {
          location_id: string
          qty?: number
          sku_id: string
          updated_at?: string
        }
        Update: {
          location_id?: string
          qty?: number
          sku_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inv_stocks_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inv_stocks_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inv_unclaimed_epcs: {
        Row: {
          created_at: string
          epc: string
          hits: number
          last_seen_at: string
          last_seen_location_id: string | null
          note: string | null
        }
        Insert: {
          created_at?: string
          epc: string
          hits?: number
          last_seen_at?: string
          last_seen_location_id?: string | null
          note?: string | null
        }
        Update: {
          created_at?: string
          epc?: string
          hits?: number
          last_seen_at?: string
          last_seen_location_id?: string | null
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inv_unclaimed_epcs_last_seen_location_id_fkey"
            columns: ["last_seen_location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_reservation_lines: {
        Row: {
          created_at: string
          id: string
          location_id: string
          order_item_id: string
          quantity: number
          reservation_id: string
          stock_sku_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          location_id: string
          order_item_id: string
          quantity: number
          reservation_id: string
          stock_sku_id: string
        }
        Update: {
          created_at?: string
          id?: string
          location_id?: string
          order_item_id?: string
          quantity?: number
          reservation_id?: string
          stock_sku_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_reservation_lines_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_reservation_lines_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "commerce_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_reservation_lines_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "inventory_reservations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_reservation_lines_stock_sku_id_fkey"
            columns: ["stock_sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_reservations: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          listing_id: string
          location_id: string
          order_id: string
          quantity: number
          released_at: string | null
          sku_id: string
          status: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          listing_id: string
          location_id: string
          order_id: string
          quantity?: number
          released_at?: string | null
          sku_id: string
          status?: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          listing_id?: string
          location_id?: string
          order_id?: string
          quantity?: number
          released_at?: string | null
          sku_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_reservations_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "commerce_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_reservations_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_reservations_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "commerce_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_reservations_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_sale_events: {
        Row: {
          epc: string | null
          error: string | null
          event_type: string
          event_version: number
          id: string
          processed_at: string | null
          raw_payload: Json
          received_at: string
          sku_id: string | null
          source_channel: string
          source_order_id: string
          source_shop_id: string | null
          status: string
        }
        Insert: {
          epc?: string | null
          error?: string | null
          event_type: string
          event_version?: number
          id?: string
          processed_at?: string | null
          raw_payload?: Json
          received_at?: string
          sku_id?: string | null
          source_channel: string
          source_order_id: string
          source_shop_id?: string | null
          status?: string
        }
        Update: {
          epc?: string | null
          error?: string | null
          event_type?: string
          event_version?: number
          id?: string
          processed_at?: string | null
          raw_payload?: Json
          received_at?: string
          sku_id?: string | null
          source_channel?: string
          source_order_id?: string
          source_shop_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_sale_events_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      japan_parcel_items: {
        Row: {
          addon_service: string | null
          arrival_photo_urls: Json
          condition: string | null
          created_at: string
          created_by: string | null
          domestic_freight_jpy: number | null
          exchange_rate: number | null
          freight_diff_jpy: number | null
          id: string
          item_image_url: string | null
          item_price_jpy: number | null
          item_title: string | null
          item_title_cn: string | null
          item_total_cny: number | null
          item_total_jpy: number | null
          merchant_order_no: string | null
          notes: string | null
          pack_pieces: number | null
          pack_pieces_source: string | null
          pack_unit_note: string | null
          parent_id: string
          pay_at: string | null
          pay_method: string | null
          position: number
          quantity: number | null
          raw_payload: Json | null
          service_fee_jpy: number | null
          source_platform: string | null
          sub_order_no: string | null
          system_code: string | null
          tariff_category: string | null
          tariff_rate: number | null
          unit_price_jpy: number | null
          updated_at: string
          weight_g: number | null
        }
        Insert: {
          addon_service?: string | null
          arrival_photo_urls?: Json
          condition?: string | null
          created_at?: string
          created_by?: string | null
          domestic_freight_jpy?: number | null
          exchange_rate?: number | null
          freight_diff_jpy?: number | null
          id?: string
          item_image_url?: string | null
          item_price_jpy?: number | null
          item_title?: string | null
          item_title_cn?: string | null
          item_total_cny?: number | null
          item_total_jpy?: number | null
          merchant_order_no?: string | null
          notes?: string | null
          pack_pieces?: number | null
          pack_pieces_source?: string | null
          pack_unit_note?: string | null
          parent_id: string
          pay_at?: string | null
          pay_method?: string | null
          position?: number
          quantity?: number | null
          raw_payload?: Json | null
          service_fee_jpy?: number | null
          source_platform?: string | null
          sub_order_no?: string | null
          system_code?: string | null
          tariff_category?: string | null
          tariff_rate?: number | null
          unit_price_jpy?: number | null
          updated_at?: string
          weight_g?: number | null
        }
        Update: {
          addon_service?: string | null
          arrival_photo_urls?: Json
          condition?: string | null
          created_at?: string
          created_by?: string | null
          domestic_freight_jpy?: number | null
          exchange_rate?: number | null
          freight_diff_jpy?: number | null
          id?: string
          item_image_url?: string | null
          item_price_jpy?: number | null
          item_title?: string | null
          item_title_cn?: string | null
          item_total_cny?: number | null
          item_total_jpy?: number | null
          merchant_order_no?: string | null
          notes?: string | null
          pack_pieces?: number | null
          pack_pieces_source?: string | null
          pack_unit_note?: string | null
          parent_id?: string
          pay_at?: string | null
          pay_method?: string | null
          position?: number
          quantity?: number | null
          raw_payload?: Json | null
          service_fee_jpy?: number | null
          source_platform?: string | null
          sub_order_no?: string | null
          system_code?: string | null
          tariff_category?: string | null
          tariff_rate?: number | null
          unit_price_jpy?: number | null
          updated_at?: string
          weight_g?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "japan_parcel_items_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "japan_parcels"
            referencedColumns: ["id"]
          },
        ]
      }
      japan_parcels: {
        Row: {
          account_id: string | null
          category: string | null
          completeness: number
          created_at: string
          created_by: string | null
          deleted_at: string | null
          domestic_freight_jpy: number | null
          eta: string | null
          exchange_rate: number | null
          grand_total_cny: number | null
          grand_total_jpy: number | null
          id: string
          intl_charge_method: string | null
          intl_exchange_rate: number | null
          intl_freight_jpy: number | null
          intl_keep_packaging_jpy: number | null
          intl_merchant_order_no: string | null
          intl_merge_fee_jpy: number | null
          intl_pay_at: string | null
          intl_pay_method: string | null
          intl_photo_fee_jpy: number | null
          intl_points_used: number | null
          intl_reinforce_jpy: number | null
          intl_send_fee_jpy: number | null
          intl_ship_method: string | null
          intl_total_cny: number | null
          intl_total_jpy: number | null
          is_problem: boolean
          item_image_url: string | null
          item_title: string | null
          item_title_cn: string | null
          max_side_cm: number | null
          notes: string | null
          price_jpy: number | null
          purchased_at: string | null
          raw_payload: Json | null
          received_at: string | null
          receiver_address: string | null
          receiver_name: string | null
          receiver_phone: string | null
          seller: string | null
          service_fee_jpy: number | null
          source: string
          source_order_no: string | null
          status: string
          status_text: string | null
          status_timeline: Json | null
          storage_days: number | null
          system_code: string | null
          tariff_cny: number | null
          tariff_jpy: number | null
          total_cny: number | null
          total_jpy: number | null
          total_weight_g: number | null
          tracking_no: string | null
          updated_at: string
          volume_cm3: number | null
          warehouse_location: string | null
          weight_g: number | null
        }
        Insert: {
          account_id?: string | null
          category?: string | null
          completeness?: number
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          domestic_freight_jpy?: number | null
          eta?: string | null
          exchange_rate?: number | null
          grand_total_cny?: number | null
          grand_total_jpy?: number | null
          id?: string
          intl_charge_method?: string | null
          intl_exchange_rate?: number | null
          intl_freight_jpy?: number | null
          intl_keep_packaging_jpy?: number | null
          intl_merchant_order_no?: string | null
          intl_merge_fee_jpy?: number | null
          intl_pay_at?: string | null
          intl_pay_method?: string | null
          intl_photo_fee_jpy?: number | null
          intl_points_used?: number | null
          intl_reinforce_jpy?: number | null
          intl_send_fee_jpy?: number | null
          intl_ship_method?: string | null
          intl_total_cny?: number | null
          intl_total_jpy?: number | null
          is_problem?: boolean
          item_image_url?: string | null
          item_title?: string | null
          item_title_cn?: string | null
          max_side_cm?: number | null
          notes?: string | null
          price_jpy?: number | null
          purchased_at?: string | null
          raw_payload?: Json | null
          received_at?: string | null
          receiver_address?: string | null
          receiver_name?: string | null
          receiver_phone?: string | null
          seller?: string | null
          service_fee_jpy?: number | null
          source?: string
          source_order_no?: string | null
          status?: string
          status_text?: string | null
          status_timeline?: Json | null
          storage_days?: number | null
          system_code?: string | null
          tariff_cny?: number | null
          tariff_jpy?: number | null
          total_cny?: number | null
          total_jpy?: number | null
          total_weight_g?: number | null
          tracking_no?: string | null
          updated_at?: string
          volume_cm3?: number | null
          warehouse_location?: string | null
          weight_g?: number | null
        }
        Update: {
          account_id?: string | null
          category?: string | null
          completeness?: number
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          domestic_freight_jpy?: number | null
          eta?: string | null
          exchange_rate?: number | null
          grand_total_cny?: number | null
          grand_total_jpy?: number | null
          id?: string
          intl_charge_method?: string | null
          intl_exchange_rate?: number | null
          intl_freight_jpy?: number | null
          intl_keep_packaging_jpy?: number | null
          intl_merchant_order_no?: string | null
          intl_merge_fee_jpy?: number | null
          intl_pay_at?: string | null
          intl_pay_method?: string | null
          intl_photo_fee_jpy?: number | null
          intl_points_used?: number | null
          intl_reinforce_jpy?: number | null
          intl_send_fee_jpy?: number | null
          intl_ship_method?: string | null
          intl_total_cny?: number | null
          intl_total_jpy?: number | null
          is_problem?: boolean
          item_image_url?: string | null
          item_title?: string | null
          item_title_cn?: string | null
          max_side_cm?: number | null
          notes?: string | null
          price_jpy?: number | null
          purchased_at?: string | null
          raw_payload?: Json | null
          received_at?: string | null
          receiver_address?: string | null
          receiver_name?: string | null
          receiver_phone?: string | null
          seller?: string | null
          service_fee_jpy?: number | null
          source?: string
          source_order_no?: string | null
          status?: string
          status_text?: string | null
          status_timeline?: Json | null
          storage_days?: number | null
          system_code?: string | null
          tariff_cny?: number | null
          tariff_jpy?: number | null
          total_cny?: number | null
          total_jpy?: number | null
          total_weight_g?: number | null
          tracking_no?: string | null
          updated_at?: string
          volume_cm3?: number | null
          warehouse_location?: string | null
          weight_g?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "japan_parcels_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "meruki_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      meruki_accounts: {
        Row: {
          cookie_expires_at: string | null
          created_at: string
          display_name: string | null
          id: string
          ingest_token: string
          last_error: string | null
          last_login_at: string | null
          last_login_status: string | null
          password_encrypted: string
          session_cookie: string | null
          updated_at: string
          username: string
        }
        Insert: {
          cookie_expires_at?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          ingest_token?: string
          last_error?: string | null
          last_login_at?: string | null
          last_login_status?: string | null
          password_encrypted: string
          session_cookie?: string | null
          updated_at?: string
          username: string
        }
        Update: {
          cookie_expires_at?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          ingest_token?: string
          last_error?: string | null
          last_login_at?: string | null
          last_login_status?: string | null
          password_encrypted?: string
          session_cookie?: string | null
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
      meruki_raw_captures: {
        Row: {
          account_id: string | null
          captured_at: string
          id: string
          payload: Json
          recognized: boolean
          source_url: string
        }
        Insert: {
          account_id?: string | null
          captured_at?: string
          id?: string
          payload: Json
          recognized?: boolean
          source_url: string
        }
        Update: {
          account_id?: string | null
          captured_at?: string
          id?: string
          payload?: Json
          recognized?: boolean
          source_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "meruki_raw_captures_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "meruki_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      meruki_sync_runs: {
        Row: {
          account_id: string | null
          fetched_count: number
          finished_at: string | null
          id: string
          inserted_count: number
          message: string | null
          started_at: string
          status: string
          updated_count: number
        }
        Insert: {
          account_id?: string | null
          fetched_count?: number
          finished_at?: string | null
          id?: string
          inserted_count?: number
          message?: string | null
          started_at?: string
          status?: string
          updated_count?: number
        }
        Update: {
          account_id?: string | null
          fetched_count?: number
          finished_at?: string | null
          id?: string
          inserted_count?: number
          message?: string | null
          started_at?: string
          status?: string
          updated_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "meruki_sync_runs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "meruki_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      official_knowledge_entries: {
        Row: {
          care_advice: string[]
          cover_url: string | null
          created_at: string
          created_by: string | null
          evidence: string[]
          id: string
          keywords: string[]
          published_at: string | null
          reviewed_by: string | null
          slug: string
          status: Database["public"]["Enums"]["editorial_content_status"]
          story: string
          summary: string
          title: string
          type: string
          updated_at: string
        }
        Insert: {
          care_advice?: string[]
          cover_url?: string | null
          created_at?: string
          created_by?: string | null
          evidence?: string[]
          id?: string
          keywords?: string[]
          published_at?: string | null
          reviewed_by?: string | null
          slug: string
          status?: Database["public"]["Enums"]["editorial_content_status"]
          story: string
          summary: string
          title: string
          type: string
          updated_at?: string
        }
        Update: {
          care_advice?: string[]
          cover_url?: string | null
          created_at?: string
          created_by?: string | null
          evidence?: string[]
          id?: string
          keywords?: string[]
          published_at?: string | null
          reviewed_by?: string | null
          slug?: string
          status?: Database["public"]["Enums"]["editorial_content_status"]
          story?: string
          summary?: string
          title?: string
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      official_knowledge_relations: {
        Row: {
          created_at: string
          entity_key: string
          entity_type: string
          id: string
          is_primary: boolean
          knowledge_id: string
          label: string
        }
        Insert: {
          created_at?: string
          entity_key: string
          entity_type: string
          id?: string
          is_primary?: boolean
          knowledge_id: string
          label: string
        }
        Update: {
          created_at?: string
          entity_key?: string
          entity_type?: string
          id?: string
          is_primary?: boolean
          knowledge_id?: string
          label?: string
        }
        Relationships: [
          {
            foreignKeyName: "official_knowledge_relations_knowledge_id_fkey"
            columns: ["knowledge_id"]
            isOneToOne: false
            referencedRelation: "official_knowledge_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      org_addresses: {
        Row: {
          address: string
          created_at: string
          created_by: string | null
          id: string
          is_default: boolean
          label: string
          receiver_name: string | null
          receiver_phone: string | null
          updated_at: string
        }
        Insert: {
          address: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_default?: boolean
          label: string
          receiver_name?: string | null
          receiver_phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_default?: boolean
          label?: string
          receiver_name?: string | null
          receiver_phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      package_evidence: {
        Row: {
          captured_at: string
          captured_by: string | null
          device_id: string | null
          id: string
          kind: string
          package_id: string
          storage_path: string
        }
        Insert: {
          captured_at?: string
          captured_by?: string | null
          device_id?: string | null
          id?: string
          kind: string
          package_id: string
          storage_path: string
        }
        Update: {
          captured_at?: string
          captured_by?: string | null
          device_id?: string | null
          id?: string
          kind?: string
          package_id?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "package_evidence_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "inv_handheld_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "package_evidence_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "packages"
            referencedColumns: ["id"]
          },
        ]
      }
      packages: {
        Row: {
          created_at: string
          created_by: string | null
          fulfillment_id: string
          height_cm: number | null
          id: string
          length_cm: number | null
          packaging_material: string | null
          sealed_at: string | null
          updated_at: string
          weight_g: number | null
          width_cm: number | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          fulfillment_id: string
          height_cm?: number | null
          id?: string
          length_cm?: number | null
          packaging_material?: string | null
          sealed_at?: string | null
          updated_at?: string
          weight_g?: number | null
          width_cm?: number | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          fulfillment_id?: string
          height_cm?: number | null
          id?: string
          length_cm?: number | null
          packaging_material?: string | null
          sealed_at?: string | null
          updated_at?: string
          weight_g?: number | null
          width_cm?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "packages_fulfillment_id_fkey"
            columns: ["fulfillment_id"]
            isOneToOne: true
            referencedRelation: "fulfillments"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_subject_applications: {
        Row: {
          application_snapshot: Json
          created_at: string
          id: string
          note: string | null
          provider: string
          provider_application_id: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          subject_id: string
          submitted_at: string | null
          submitted_by: string | null
        }
        Insert: {
          application_snapshot?: Json
          created_at?: string
          id?: string
          note?: string | null
          provider?: string
          provider_application_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status: string
          subject_id: string
          submitted_at?: string | null
          submitted_by?: string | null
        }
        Update: {
          application_snapshot?: Json
          created_at?: string
          id?: string
          note?: string | null
          provider?: string
          provider_application_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          subject_id?: string
          submitted_at?: string | null
          submitted_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_subject_applications_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "payment_subjects"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_subjects: {
        Row: {
          business_license_storage_path: string | null
          contact_name: string
          contact_phone: string
          created_at: string
          created_by: string | null
          erp_verification_note: string | null
          erp_verification_status: string
          id: string
          legal_name: string
          legal_representative_name: string
          provider_application_id: string | null
          provider_application_status: string
          provider_status_note: string | null
          subject_code: string
          subject_type: string
          unified_social_credit_code: string
          updated_at: string
          verified_at: string | null
          verified_by: string | null
          wechat_appid: string | null
          wechat_sub_mchid: string | null
        }
        Insert: {
          business_license_storage_path?: string | null
          contact_name: string
          contact_phone: string
          created_at?: string
          created_by?: string | null
          erp_verification_note?: string | null
          erp_verification_status?: string
          id?: string
          legal_name: string
          legal_representative_name: string
          provider_application_id?: string | null
          provider_application_status?: string
          provider_status_note?: string | null
          subject_code?: string
          subject_type: string
          unified_social_credit_code: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
          wechat_appid?: string | null
          wechat_sub_mchid?: string | null
        }
        Update: {
          business_license_storage_path?: string | null
          contact_name?: string
          contact_phone?: string
          created_at?: string
          created_by?: string | null
          erp_verification_note?: string | null
          erp_verification_status?: string
          id?: string
          legal_name?: string
          legal_representative_name?: string
          provider_application_id?: string | null
          provider_application_status?: string
          provider_status_note?: string | null
          subject_code?: string
          subject_type?: string
          unified_social_credit_code?: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
          wechat_appid?: string | null
          wechat_sub_mchid?: string | null
        }
        Relationships: []
      }
      pos_authorizations: {
        Row: {
          action: string
          approved_value: Json
          authorizer_id: string
          created_at: string
          expires_at: string
          id: string
          location_id: string
          operator_id: string
          reason: string | null
          requested_value: Json
          status: string
        }
        Insert: {
          action: string
          approved_value?: Json
          authorizer_id: string
          created_at?: string
          expires_at?: string
          id?: string
          location_id: string
          operator_id: string
          reason?: string | null
          requested_value?: Json
          status?: string
        }
        Update: {
          action?: string
          approved_value?: Json
          authorizer_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          location_id?: string
          operator_id?: string
          reason?: string | null
          requested_value?: Json
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_authorizations_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_cash_movements: {
        Row: {
          amount: number
          created_at: string
          id: string
          operator_id: string
          order_id: string | null
          reason: string | null
          shift_id: string
          type: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          operator_id: string
          order_id?: string | null
          reason?: string | null
          shift_id: string
          type: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          operator_id?: string
          order_id?: string | null
          reason?: string | null
          shift_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_cash_movements_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "commerce_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_cash_movements_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "pos_shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_customer_coupons: {
        Row: {
          code: string
          created_at: string
          customer_id: string
          discount_type: string
          expires_at: string | null
          id: string
          metadata: Json
          min_spend: number
          name: string
          starts_at: string | null
          status: string
          updated_at: string
          value: number
        }
        Insert: {
          code: string
          created_at?: string
          customer_id: string
          discount_type: string
          expires_at?: string | null
          id?: string
          metadata?: Json
          min_spend?: number
          name: string
          starts_at?: string | null
          status?: string
          updated_at?: string
          value: number
        }
        Update: {
          code?: string
          created_at?: string
          customer_id?: string
          discount_type?: string
          expires_at?: string | null
          id?: string
          metadata?: Json
          min_spend?: number
          name?: string
          starts_at?: string | null
          status?: string
          updated_at?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "pos_customer_coupons_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "commerce_customers"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_customer_wallets: {
        Row: {
          customer_id: string
          member_level: string
          metadata: Json
          points: number
          store_credit: number
          updated_at: string
        }
        Insert: {
          customer_id: string
          member_level?: string
          metadata?: Json
          points?: number
          store_credit?: number
          updated_at?: string
        }
        Update: {
          customer_id?: string
          member_level?: string
          metadata?: Json
          points?: number
          store_credit?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_customer_wallets_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "commerce_customers"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_discount_policies: {
        Row: {
          allowed_roles: string[]
          applies_to_ownership: string[]
          created_at: string
          discount_type: string
          id: string
          is_active: boolean
          location_id: string | null
          max_amount: number | null
          min_pay_rate: number
          name: string
          requires_reason: boolean
          scope: string
          updated_at: string
        }
        Insert: {
          allowed_roles?: string[]
          applies_to_ownership?: string[]
          created_at?: string
          discount_type: string
          id?: string
          is_active?: boolean
          location_id?: string | null
          max_amount?: number | null
          min_pay_rate?: number
          name: string
          requires_reason?: boolean
          scope?: string
          updated_at?: string
        }
        Update: {
          allowed_roles?: string[]
          applies_to_ownership?: string[]
          created_at?: string
          discount_type?: string
          id?: string
          is_active?: boolean
          location_id?: string | null
          max_amount?: number | null
          min_pay_rate?: number
          name?: string
          requires_reason?: boolean
          scope?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_discount_policies_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_held_cart_items: {
        Row: {
          category_code: string | null
          category_name_snapshot: string | null
          discount_eligible: boolean
          held_cart_id: string
          id: string
          ownership_snapshot: string
          price_snapshot: number
          quantity: number
          sku_id: string
          subcategory_code: string | null
          subcategory_name: string | null
          subcategory_name_snapshot: string | null
        }
        Insert: {
          category_code?: string | null
          category_name_snapshot?: string | null
          discount_eligible?: boolean
          held_cart_id: string
          id?: string
          ownership_snapshot?: string
          price_snapshot: number
          quantity: number
          sku_id: string
          subcategory_code?: string | null
          subcategory_name?: string | null
          subcategory_name_snapshot?: string | null
        }
        Update: {
          category_code?: string | null
          category_name_snapshot?: string | null
          discount_eligible?: boolean
          held_cart_id?: string
          id?: string
          ownership_snapshot?: string
          price_snapshot?: number
          quantity?: number
          sku_id?: string
          subcategory_code?: string | null
          subcategory_name?: string | null
          subcategory_name_snapshot?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pos_held_cart_items_held_cart_id_fkey"
            columns: ["held_cart_id"]
            isOneToOne: false
            referencedRelation: "pos_held_carts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_held_cart_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_held_carts: {
        Row: {
          benefit_snapshot: Json
          client_op_id: string
          customer_id: string | null
          discount_snapshot: Json
          held_at: string
          id: string
          location_id: string
          note: string | null
          operator_id: string
          resumed_at: string | null
          shift_id: string
          status: string
          updated_at: string
        }
        Insert: {
          benefit_snapshot?: Json
          client_op_id: string
          customer_id?: string | null
          discount_snapshot?: Json
          held_at?: string
          id?: string
          location_id: string
          note?: string | null
          operator_id: string
          resumed_at?: string | null
          shift_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          benefit_snapshot?: Json
          client_op_id?: string
          customer_id?: string | null
          discount_snapshot?: Json
          held_at?: string
          id?: string
          location_id?: string
          note?: string | null
          operator_id?: string
          resumed_at?: string | null
          shift_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_held_carts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "commerce_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_held_carts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_held_carts_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "pos_shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_payment_attempts: {
        Row: {
          amount: number
          auth_code_hash: string | null
          auth_code_last4: string | null
          client_op_id: string
          closed_at: string | null
          code_url: string | null
          created_at: string
          currency: string
          customer_id: string | null
          error_code: string | null
          error_message: string | null
          expires_at: string | null
          id: string
          location_id: string
          mode: string
          operator_id: string
          order_id: string | null
          out_trade_no: string
          paid_at: string | null
          payment_profile_id: string | null
          provider: string
          provider_response: Json
          provider_transaction_id: string | null
          qr_content: string | null
          sale_payload: Json
          settlement_subject_id: string | null
          shift_id: string
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          auth_code_hash?: string | null
          auth_code_last4?: string | null
          client_op_id: string
          closed_at?: string | null
          code_url?: string | null
          created_at?: string
          currency?: string
          customer_id?: string | null
          error_code?: string | null
          error_message?: string | null
          expires_at?: string | null
          id?: string
          location_id: string
          mode: string
          operator_id: string
          order_id?: string | null
          out_trade_no: string
          paid_at?: string | null
          payment_profile_id?: string | null
          provider: string
          provider_response?: Json
          provider_transaction_id?: string | null
          qr_content?: string | null
          sale_payload?: Json
          settlement_subject_id?: string | null
          shift_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          auth_code_hash?: string | null
          auth_code_last4?: string | null
          client_op_id?: string
          closed_at?: string | null
          code_url?: string | null
          created_at?: string
          currency?: string
          customer_id?: string | null
          error_code?: string | null
          error_message?: string | null
          expires_at?: string | null
          id?: string
          location_id?: string
          mode?: string
          operator_id?: string
          order_id?: string | null
          out_trade_no?: string
          paid_at?: string | null
          payment_profile_id?: string | null
          provider?: string
          provider_response?: Json
          provider_transaction_id?: string | null
          qr_content?: string | null
          sale_payload?: Json
          settlement_subject_id?: string | null
          shift_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_payment_attempts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_payment_attempts_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "commerce_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_payment_attempts_payment_profile_id_fkey"
            columns: ["payment_profile_id"]
            isOneToOne: false
            referencedRelation: "store_payment_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_payment_attempts_settlement_subject_id_fkey"
            columns: ["settlement_subject_id"]
            isOneToOne: false
            referencedRelation: "payment_subjects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_payment_attempts_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "pos_shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_receipts: {
        Row: {
          created_at: string
          id: string
          last_printed_at: string | null
          order_id: string
          payload: Json
          print_count: number
          receipt_no: string
          shift_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_printed_at?: string | null
          order_id: string
          payload?: Json
          print_count?: number
          receipt_no: string
          shift_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_printed_at?: string | null
          order_id?: string
          payload?: Json
          print_count?: number
          receipt_no?: string
          shift_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_receipts_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: true
            referencedRelation: "commerce_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_receipts_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "pos_shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_registers: {
        Row: {
          code: string
          created_at: string
          device_id: string | null
          id: string
          is_active: boolean
          location_id: string
          name: string
          receipt_prefix: string
          settings: Json
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          device_id?: string | null
          id?: string
          is_active?: boolean
          location_id: string
          name: string
          receipt_prefix?: string
          settings?: Json
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          device_id?: string | null
          id?: string
          is_active?: boolean
          location_id?: string
          name?: string
          receipt_prefix?: string
          settings?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_registers_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "inv_handheld_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_registers_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_return_items: {
        Row: {
          id: string
          inspection_status: string
          order_item_id: string
          physical_status: string
          quantity: number
          refund_amount: number
          return_id: string
          sku_id: string
        }
        Insert: {
          id?: string
          inspection_status?: string
          order_item_id: string
          physical_status?: string
          quantity: number
          refund_amount: number
          return_id: string
          sku_id: string
        }
        Update: {
          id?: string
          inspection_status?: string
          order_item_id?: string
          physical_status?: string
          quantity?: number
          refund_amount?: number
          return_id?: string
          sku_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_return_items_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "commerce_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_return_items_return_id_fkey"
            columns: ["return_id"]
            isOneToOne: false
            referencedRelation: "pos_returns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_return_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_returns: {
        Row: {
          authorization_id: string | null
          client_op_id: string
          completed_at: string | null
          created_at: string
          id: string
          location_id: string
          operator_id: string
          order_id: string
          reason: string
          refund_total: number
          shift_id: string
          status: string
        }
        Insert: {
          authorization_id?: string | null
          client_op_id: string
          completed_at?: string | null
          created_at?: string
          id?: string
          location_id: string
          operator_id: string
          order_id: string
          reason: string
          refund_total?: number
          shift_id: string
          status?: string
        }
        Update: {
          authorization_id?: string | null
          client_op_id?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          location_id?: string
          operator_id?: string
          order_id?: string
          reason?: string
          refund_total?: number
          shift_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_returns_authorization_id_fkey"
            columns: ["authorization_id"]
            isOneToOne: false
            referencedRelation: "pos_authorizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_returns_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_returns_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "commerce_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_returns_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "pos_shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_shifts: {
        Row: {
          cash_difference: number | null
          close_note: string | null
          closed_at: string | null
          counted_cash: number | null
          created_at: string
          expected_cash: number | null
          id: string
          location_id: string
          opened_at: string
          opening_cash: number
          operator_id: string
          register_id: string
          status: string
          updated_at: string
        }
        Insert: {
          cash_difference?: number | null
          close_note?: string | null
          closed_at?: string | null
          counted_cash?: number | null
          created_at?: string
          expected_cash?: number | null
          id?: string
          location_id: string
          opened_at?: string
          opening_cash?: number
          operator_id: string
          register_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          cash_difference?: number | null
          close_note?: string | null
          closed_at?: string | null
          counted_cash?: number | null
          created_at?: string
          expected_cash?: number | null
          id?: string
          location_id?: string
          opened_at?: string
          opening_cash?: number
          operator_id?: string
          register_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_shifts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_shifts_register_id_fkey"
            columns: ["register_id"]
            isOneToOne: false
            referencedRelation: "pos_registers"
            referencedColumns: ["id"]
          },
        ]
      }
      print_events: {
        Row: {
          client_op_id: string | null
          copies: number
          created_at: string
          device_id: string | null
          document_type: string
          error_message: string | null
          fulfillment_id: string | null
          id: string
          operator_id: string | null
          result: string
          shipment_id: string | null
          template_version: string
        }
        Insert: {
          client_op_id?: string | null
          copies?: number
          created_at?: string
          device_id?: string | null
          document_type: string
          error_message?: string | null
          fulfillment_id?: string | null
          id?: string
          operator_id?: string | null
          result: string
          shipment_id?: string | null
          template_version: string
        }
        Update: {
          client_op_id?: string | null
          copies?: number
          created_at?: string
          device_id?: string | null
          document_type?: string
          error_message?: string | null
          fulfillment_id?: string | null
          id?: string
          operator_id?: string | null
          result?: string
          shipment_id?: string | null
          template_version?: string
        }
        Relationships: [
          {
            foreignKeyName: "print_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "inv_handheld_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_events_fulfillment_id_fkey"
            columns: ["fulfillment_id"]
            isOneToOne: false
            referencedRelation: "fulfillments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_events_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      }
      return_inspections: {
        Row: {
          channel_restore_status: string
          completed_at: string | null
          created_at: string
          epc: string | null
          grade_changed: boolean
          id: string
          images_changed: boolean
          inspection_result: string | null
          inspector_id: string | null
          notes: string | null
          physical_status: string | null
          price_changed: boolean
          refund_source_channel: string | null
          refund_source_order_id: string | null
          refund_status: string | null
          restock_location_id: string | null
          restock_movement_id: string | null
          sale_event_id: string | null
          sku_id: string
          updated_at: string
        }
        Insert: {
          channel_restore_status?: string
          completed_at?: string | null
          created_at?: string
          epc?: string | null
          grade_changed?: boolean
          id?: string
          images_changed?: boolean
          inspection_result?: string | null
          inspector_id?: string | null
          notes?: string | null
          physical_status?: string | null
          price_changed?: boolean
          refund_source_channel?: string | null
          refund_source_order_id?: string | null
          refund_status?: string | null
          restock_location_id?: string | null
          restock_movement_id?: string | null
          sale_event_id?: string | null
          sku_id: string
          updated_at?: string
        }
        Update: {
          channel_restore_status?: string
          completed_at?: string | null
          created_at?: string
          epc?: string | null
          grade_changed?: boolean
          id?: string
          images_changed?: boolean
          inspection_result?: string | null
          inspector_id?: string | null
          notes?: string | null
          physical_status?: string | null
          price_changed?: boolean
          refund_source_channel?: string | null
          refund_source_order_id?: string | null
          refund_status?: string | null
          restock_location_id?: string | null
          restock_movement_id?: string | null
          sale_event_id?: string | null
          sku_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "return_inspections_restock_location_id_fkey"
            columns: ["restock_location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "return_inspections_sale_event_id_fkey"
            columns: ["sale_event_id"]
            isOneToOne: false
            referencedRelation: "inventory_sale_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "return_inspections_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      shipment_events: {
        Row: {
          created_at: string
          description: string | null
          event_code: string
          event_time: string
          id: string
          provider_event_id: string | null
          raw_payload: Json | null
          shipment_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          event_code: string
          event_time: string
          id?: string
          provider_event_id?: string | null
          raw_payload?: Json | null
          shipment_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          event_code?: string
          event_time?: string
          id?: string
          provider_event_id?: string | null
          raw_payload?: Json | null
          shipment_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipment_events_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      }
      shipments: {
        Row: {
          booked_at: string | null
          created_at: string
          delivered_at: string | null
          fulfillment_id: string
          id: string
          idempotency_key: string
          label_payload: Json | null
          last_error: string | null
          package_id: string | null
          picked_up_at: string | null
          pickup_window: Json | null
          provider: string
          provider_order_no: string | null
          service_code: string
          status: string
          tracking_no: string | null
          updated_at: string
        }
        Insert: {
          booked_at?: string | null
          created_at?: string
          delivered_at?: string | null
          fulfillment_id: string
          id?: string
          idempotency_key: string
          label_payload?: Json | null
          last_error?: string | null
          package_id?: string | null
          picked_up_at?: string | null
          pickup_window?: Json | null
          provider: string
          provider_order_no?: string | null
          service_code: string
          status?: string
          tracking_no?: string | null
          updated_at?: string
        }
        Update: {
          booked_at?: string | null
          created_at?: string
          delivered_at?: string | null
          fulfillment_id?: string
          id?: string
          idempotency_key?: string
          label_payload?: Json | null
          last_error?: string | null
          package_id?: string | null
          picked_up_at?: string | null
          pickup_window?: Json | null
          provider?: string
          provider_order_no?: string | null
          service_code?: string
          status?: string
          tracking_no?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipments_fulfillment_id_fkey"
            columns: ["fulfillment_id"]
            isOneToOne: true
            referencedRelation: "fulfillments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "packages"
            referencedColumns: ["id"]
          },
        ]
      }
      sku_channel_listings: {
        Row: {
          channel: string
          created_at: string
          external_item_id: string | null
          external_sku_id: string | null
          external_spu_id: string | null
          extra: Json
          id: string
          last_error: string | null
          last_pushed_at: string | null
          last_stock: number | null
          last_stock_pushed: number | null
          last_verified_at: string | null
          listing_status: string
          sell_channel_id: string | null
          shop_id: string | null
          sku_id: string
          stock_mode: string | null
          updated_at: string
          verified_inventory_version: number
        }
        Insert: {
          channel: string
          created_at?: string
          external_item_id?: string | null
          external_sku_id?: string | null
          external_spu_id?: string | null
          extra?: Json
          id?: string
          last_error?: string | null
          last_pushed_at?: string | null
          last_stock?: number | null
          last_stock_pushed?: number | null
          last_verified_at?: string | null
          listing_status?: string
          sell_channel_id?: string | null
          shop_id?: string | null
          sku_id: string
          stock_mode?: string | null
          updated_at?: string
          verified_inventory_version?: number
        }
        Update: {
          channel?: string
          created_at?: string
          external_item_id?: string | null
          external_sku_id?: string | null
          external_spu_id?: string | null
          extra?: Json
          id?: string
          last_error?: string | null
          last_pushed_at?: string | null
          last_stock?: number | null
          last_stock_pushed?: number | null
          last_verified_at?: string | null
          listing_status?: string
          sell_channel_id?: string | null
          shop_id?: string | null
          sku_id?: string
          stock_mode?: string | null
          updated_at?: string
          verified_inventory_version?: number
        }
        Relationships: [
          {
            foreignKeyName: "sku_channel_listings_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      sku_youzan_links: {
        Row: {
          created_at: string
          id: string
          last_error: string | null
          last_pull_at: string | null
          last_pull_stock: number | null
          last_pushed_at: string | null
          last_pushed_stock: number | null
          role: string
          shop_id: string
          sku_id: string
          status: string
          sync_stock: boolean
          updated_at: string
          yz_item_id: number
          yz_sku_id: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          last_error?: string | null
          last_pull_at?: string | null
          last_pull_stock?: number | null
          last_pushed_at?: string | null
          last_pushed_stock?: number | null
          role?: string
          shop_id: string
          sku_id: string
          status?: string
          sync_stock?: boolean
          updated_at?: string
          yz_item_id: number
          yz_sku_id?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          last_error?: string | null
          last_pull_at?: string | null
          last_pull_stock?: number | null
          last_pushed_at?: string | null
          last_pushed_stock?: number | null
          role?: string
          shop_id?: string
          sku_id?: string
          status?: string
          sync_stock?: boolean
          updated_at?: string
          yz_item_id?: number
          yz_sku_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sku_youzan_links_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "youzan_shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_youzan_links_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_transfer_epcs: {
        Row: {
          epc: string
          receive_scanned_at: string | null
          ship_scanned_at: string | null
          sku_id: string | null
          transfer_id: string
        }
        Insert: {
          epc: string
          receive_scanned_at?: string | null
          ship_scanned_at?: string | null
          sku_id?: string | null
          transfer_id: string
        }
        Update: {
          epc?: string
          receive_scanned_at?: string | null
          ship_scanned_at?: string | null
          sku_id?: string | null
          transfer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_transfer_epcs_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfer_epcs_transfer_id_fkey"
            columns: ["transfer_id"]
            isOneToOne: false
            referencedRelation: "stock_transfers"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_transfer_lines: {
        Row: {
          created_at: string
          expected_qty: number
          id: string
          received_qty: number
          shipped_qty: number
          sku_id: string
          transfer_id: string
        }
        Insert: {
          created_at?: string
          expected_qty?: number
          id?: string
          received_qty?: number
          shipped_qty?: number
          sku_id: string
          transfer_id: string
        }
        Update: {
          created_at?: string
          expected_qty?: number
          id?: string
          received_qty?: number
          shipped_qty?: number
          sku_id?: string
          transfer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_transfer_lines_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfer_lines_transfer_id_fkey"
            columns: ["transfer_id"]
            isOneToOne: false
            referencedRelation: "stock_transfers"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_transfers: {
        Row: {
          code: string
          created_at: string
          from_location_id: string | null
          from_shop_id: string | null
          from_sku_id: string | null
          from_youzan_item_id: number | null
          id: string
          kind: string
          notes: string | null
          operator: string | null
          posted_at: string | null
          qty: number
          reason: string | null
          received_at: string | null
          received_by: string | null
          shipped_at: string | null
          shipped_by: string | null
          status: string
          to_location_id: string | null
          to_shop_id: string | null
          to_sku_id: string | null
          to_youzan_item_id: number | null
          updated_at: string
          youzan_error_msg: string | null
          youzan_sync_status: string
        }
        Insert: {
          code?: string
          created_at?: string
          from_location_id?: string | null
          from_shop_id?: string | null
          from_sku_id?: string | null
          from_youzan_item_id?: number | null
          id?: string
          kind: string
          notes?: string | null
          operator?: string | null
          posted_at?: string | null
          qty: number
          reason?: string | null
          received_at?: string | null
          received_by?: string | null
          shipped_at?: string | null
          shipped_by?: string | null
          status?: string
          to_location_id?: string | null
          to_shop_id?: string | null
          to_sku_id?: string | null
          to_youzan_item_id?: number | null
          updated_at?: string
          youzan_error_msg?: string | null
          youzan_sync_status?: string
        }
        Update: {
          code?: string
          created_at?: string
          from_location_id?: string | null
          from_shop_id?: string | null
          from_sku_id?: string | null
          from_youzan_item_id?: number | null
          id?: string
          kind?: string
          notes?: string | null
          operator?: string | null
          posted_at?: string | null
          qty?: number
          reason?: string | null
          received_at?: string | null
          received_by?: string | null
          shipped_at?: string | null
          shipped_by?: string | null
          status?: string
          to_location_id?: string | null
          to_shop_id?: string | null
          to_sku_id?: string | null
          to_youzan_item_id?: number | null
          updated_at?: string
          youzan_error_msg?: string | null
          youzan_sync_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_transfers_from_location_id_fkey"
            columns: ["from_location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfers_from_shop_id_fkey"
            columns: ["from_shop_id"]
            isOneToOne: false
            referencedRelation: "youzan_shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfers_from_sku_id_fkey"
            columns: ["from_sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfers_to_location_id_fkey"
            columns: ["to_location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfers_to_shop_id_fkey"
            columns: ["to_shop_id"]
            isOneToOne: false
            referencedRelation: "youzan_shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfers_to_sku_id_fkey"
            columns: ["to_sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      stocktake_lines: {
        Row: {
          counted_qty: number
          diff: number
          id: string
          reason: string | null
          sku_id: string
          stocktake_id: string
          system_qty: number
        }
        Insert: {
          counted_qty?: number
          diff?: number
          id?: string
          reason?: string | null
          sku_id: string
          stocktake_id: string
          system_qty?: number
        }
        Update: {
          counted_qty?: number
          diff?: number
          id?: string
          reason?: string | null
          sku_id?: string
          stocktake_id?: string
          system_qty?: number
        }
        Relationships: [
          {
            foreignKeyName: "stocktake_lines_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_lines_stocktake_id_fkey"
            columns: ["stocktake_id"]
            isOneToOne: false
            referencedRelation: "stocktakes"
            referencedColumns: ["id"]
          },
        ]
      }
      stocktake_scans: {
        Row: {
          device_id: string | null
          epc: string
          id: string
          scanned_at: string
          sku_id: string | null
          stocktake_id: string
        }
        Insert: {
          device_id?: string | null
          epc: string
          id?: string
          scanned_at?: string
          sku_id?: string | null
          stocktake_id: string
        }
        Update: {
          device_id?: string | null
          epc?: string
          id?: string
          scanned_at?: string
          sku_id?: string | null
          stocktake_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stocktake_scans_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "inv_handheld_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_scans_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_scans_stocktake_id_fkey"
            columns: ["stocktake_id"]
            isOneToOne: false
            referencedRelation: "stocktakes"
            referencedColumns: ["id"]
          },
        ]
      }
      stocktakes: {
        Row: {
          code: string
          created_at: string
          id: string
          location_id: string
          notes: string | null
          opened_at: string
          opened_by: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          submitted_at: string | null
          submitted_by: string | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          location_id: string
          notes?: string | null
          opened_at?: string
          opened_by?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string | null
          submitted_by?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          location_id?: string
          notes?: string | null
          opened_at?: string
          opened_by?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string | null
          submitted_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stocktakes_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      store_payment_profiles: {
        Row: {
          channel: string
          created_at: string
          created_by: string | null
          id: string
          is_enabled: boolean
          location_id: string
          payment_code: string
          qr_mode: string
          status: string
          subject_id: string | null
          updated_at: string
        }
        Insert: {
          channel?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_enabled?: boolean
          location_id: string
          payment_code?: string
          qr_mode?: string
          status?: string
          subject_id?: string | null
          updated_at?: string
        }
        Update: {
          channel?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_enabled?: boolean
          location_id?: string
          payment_code?: string
          qr_mode?: string
          status?: string
          subject_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "store_payment_profiles_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: true
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_payment_profiles_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "payment_subjects"
            referencedColumns: ["id"]
          },
        ]
      }
      user_location_perms: {
        Row: {
          created_at: string
          location_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          location_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          location_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_location_perms_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      warehouse_totes: {
        Row: {
          code: string
          created_at: string
          current_fulfillment_id: string | null
          id: string
          location_id: string
          status: string
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          current_fulfillment_id?: string | null
          id?: string
          location_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          current_fulfillment_id?: string | null
          id?: string
          location_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "warehouse_totes_current_fulfillment_id_fkey"
            columns: ["current_fulfillment_id"]
            isOneToOne: false
            referencedRelation: "fulfillments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warehouse_totes_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      youzan_items: {
        Row: {
          created_at: string
          id: string
          is_listed: boolean
          item_id: number
          kdt_id: number
          pic_url: string | null
          price: number | null
          raw: Json | null
          shop_id: string
          stock_qty: number
          title: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_listed?: boolean
          item_id: number
          kdt_id: number
          pic_url?: string | null
          price?: number | null
          raw?: Json | null
          shop_id: string
          stock_qty?: number
          title?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_listed?: boolean
          item_id?: number
          kdt_id?: number
          pic_url?: string | null
          price?: number | null
          raw?: Json | null
          shop_id?: string
          stock_qty?: number
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "youzan_items_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "youzan_shops"
            referencedColumns: ["id"]
          },
        ]
      }
      youzan_orders: {
        Row: {
          buyer_nick: string | null
          buyer_open_id: string | null
          created_time: string | null
          first_item_image: string | null
          id: string
          inserted_at: string
          item_count: number | null
          item_titles: string | null
          kdt_id: number
          num: number | null
          outer_transaction_no: string | null
          pay_time: string | null
          pay_type: number | null
          payment: number | null
          post_fee: number | null
          raw: Json | null
          receiver_address: string | null
          receiver_name: string | null
          receiver_tel: string | null
          shop_id: string
          sku_count: number | null
          status: string | null
          status_text: string | null
          tid: string
          total_fee: number | null
          updated_at: string
        }
        Insert: {
          buyer_nick?: string | null
          buyer_open_id?: string | null
          created_time?: string | null
          first_item_image?: string | null
          id?: string
          inserted_at?: string
          item_count?: number | null
          item_titles?: string | null
          kdt_id: number
          num?: number | null
          outer_transaction_no?: string | null
          pay_time?: string | null
          pay_type?: number | null
          payment?: number | null
          post_fee?: number | null
          raw?: Json | null
          receiver_address?: string | null
          receiver_name?: string | null
          receiver_tel?: string | null
          shop_id: string
          sku_count?: number | null
          status?: string | null
          status_text?: string | null
          tid: string
          total_fee?: number | null
          updated_at?: string
        }
        Update: {
          buyer_nick?: string | null
          buyer_open_id?: string | null
          created_time?: string | null
          first_item_image?: string | null
          id?: string
          inserted_at?: string
          item_count?: number | null
          item_titles?: string | null
          kdt_id?: number
          num?: number | null
          outer_transaction_no?: string | null
          pay_time?: string | null
          pay_type?: number | null
          payment?: number | null
          post_fee?: number | null
          raw?: Json | null
          receiver_address?: string | null
          receiver_name?: string | null
          receiver_tel?: string | null
          shop_id?: string
          sku_count?: number | null
          status?: string | null
          status_text?: string | null
          tid?: string
          total_fee?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "youzan_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "youzan_shops"
            referencedColumns: ["id"]
          },
        ]
      }
      youzan_shops: {
        Row: {
          access_token: string | null
          address: string | null
          area_sqm: number | null
          authorized_at: string | null
          chain_probe_at: string | null
          chain_probe_result: Json | null
          chain_probe_status: string
          created_at: string
          expires_at: string | null
          id: string
          image_url: string | null
          kdt_id: number
          last_ping_at: string | null
          last_ping_msg: string | null
          last_ping_ok: boolean | null
          manager: string | null
          notes: string | null
          offline_sell_channel_id: number | null
          opened_at: string | null
          ownership: string
          parent_kdt_id: number | null
          phone: string | null
          refresh_token: string | null
          role: string
          sell_channel_id: number | null
          sell_channel_ids: number[]
          shop_name: string
          status: string
          store_format: string
          token_expires_at: string | null
          updated_at: string
          warehouse_code: string | null
          warehouse_name: string | null
        }
        Insert: {
          access_token?: string | null
          address?: string | null
          area_sqm?: number | null
          authorized_at?: string | null
          chain_probe_at?: string | null
          chain_probe_result?: Json | null
          chain_probe_status?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          image_url?: string | null
          kdt_id: number
          last_ping_at?: string | null
          last_ping_msg?: string | null
          last_ping_ok?: boolean | null
          manager?: string | null
          notes?: string | null
          offline_sell_channel_id?: number | null
          opened_at?: string | null
          ownership?: string
          parent_kdt_id?: number | null
          phone?: string | null
          refresh_token?: string | null
          role?: string
          sell_channel_id?: number | null
          sell_channel_ids?: number[]
          shop_name: string
          status?: string
          store_format?: string
          token_expires_at?: string | null
          updated_at?: string
          warehouse_code?: string | null
          warehouse_name?: string | null
        }
        Update: {
          access_token?: string | null
          address?: string | null
          area_sqm?: number | null
          authorized_at?: string | null
          chain_probe_at?: string | null
          chain_probe_result?: Json | null
          chain_probe_status?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          image_url?: string | null
          kdt_id?: number
          last_ping_at?: string | null
          last_ping_msg?: string | null
          last_ping_ok?: boolean | null
          manager?: string | null
          notes?: string | null
          offline_sell_channel_id?: number | null
          opened_at?: string | null
          ownership?: string
          parent_kdt_id?: number | null
          phone?: string | null
          refresh_token?: string | null
          role?: string
          sell_channel_id?: number | null
          sell_channel_ids?: number[]
          shop_name?: string
          status?: string
          store_format?: string
          token_expires_at?: string | null
          updated_at?: string
          warehouse_code?: string | null
          warehouse_name?: string | null
        }
        Relationships: []
      }
      youzan_stock_sync_queue: {
        Row: {
          action: string
          attempts: number
          created_at: string
          id: string
          last_error: string | null
          location_id: string | null
          next_run_at: string
          reason: string
          shop_id: string | null
          sku_id: string
          status: string
          target_is_display: boolean | null
          target_stock: number
          updated_at: string
        }
        Insert: {
          action?: string
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          location_id?: string | null
          next_run_at?: string
          reason?: string
          shop_id?: string | null
          sku_id: string
          status?: string
          target_is_display?: boolean | null
          target_stock: number
          updated_at?: string
        }
        Update: {
          action?: string
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          location_id?: string | null
          next_run_at?: string
          reason?: string
          shop_id?: string | null
          sku_id?: string
          status?: string
          target_is_display?: boolean | null
          target_stock?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "youzan_stock_sync_queue_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inv_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "youzan_stock_sync_queue_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "youzan_shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "youzan_stock_sync_queue_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "inv_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      youzan_sync_logs: {
        Row: {
          action: string
          count_in: number
          count_out: number
          error: string | null
          finished_at: string | null
          id: string
          kdt_id: number | null
          message: string | null
          shop_id: string | null
          started_at: string
          status: string
        }
        Insert: {
          action: string
          count_in?: number
          count_out?: number
          error?: string | null
          finished_at?: string | null
          id?: string
          kdt_id?: number | null
          message?: string | null
          shop_id?: string | null
          started_at?: string
          status?: string
        }
        Update: {
          action?: string
          count_in?: number
          count_out?: number
          error?: string | null
          finished_at?: string | null
          id?: string
          kdt_id?: number | null
          message?: string | null
          shop_id?: string | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "youzan_sync_logs_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "youzan_shops"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      aigc_sso_cleanup_expired: { Args: never; Returns: undefined }
      claim_channel_sync_tasks: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: {
          action: string
          attempts: number
          channel: string
          channel_listing_id: string | null
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          dedupe_key: string
          id: string
          inventory_version: number
          last_error: string | null
          lease_expires_at: string | null
          max_attempts: number
          next_run_at: string
          priority: number
          request_payload: Json
          response_preview: string | null
          shop_id: string | null
          sku_id: string
          status: string
          target_stock: number | null
          trace_id: string | null
          updated_at: string
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "channel_sync_outbox"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      commerce_capture_payment_allocation: {
        Args: {
          p_item_snapshots: Json
          p_order_id: string
          p_payment_id: string
          p_suborders: Json
        }
        Returns: undefined
      }
      commerce_create_after_sale: {
        Args: {
          p_evidence_urls?: Json
          p_order_item_id: string
          p_reason_code: string
          p_reason_text?: string
          p_requested_amount?: number
          p_type: string
          p_user_id: string
        }
        Returns: {
          after_sale_no: string
          approved_amount: number | null
          assigned_to: string | null
          closed_at: string | null
          created_at: string
          evidence_urls: Json
          id: string
          inspected_at: string | null
          location_id: string
          order_id: string
          order_item_id: string
          reason_code: string
          reason_text: string | null
          received_at: string | null
          refund_requested_at: string | null
          refunded_at: string | null
          rejection_reason: string | null
          requested_amount: number
          requested_at: string
          return_carrier: string | null
          return_tracking_no: string | null
          reviewed_at: string | null
          status: string
          store_note: string | null
          type: string
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "commerce_after_sales"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      commerce_create_order: {
        Args: {
          p_courier_provider: string
          p_courier_service_code: string
          p_courier_service_name?: string
          p_customer_note?: string
          p_idempotency_key: string
          p_listing_ids: string[]
          p_quote_snapshot?: Json
          p_recipient_name: string
          p_recipient_phone: string
          p_shipping_address: Json
          p_shipping_fee?: number
          p_user_id: string
        }
        Returns: {
          authorization_id: string | null
          benefit_snapshot: Json
          cancelled_at: string | null
          completed_at: string | null
          courier_provider: string | null
          courier_quote_snapshot: Json | null
          courier_service_code: string | null
          courier_service_name: string | null
          created_at: string
          currency: string
          customer_id: string | null
          customer_note: string | null
          discount_snapshot: Json
          discount_total: number
          fulfillment_method: string
          id: string
          idempotency_key: string
          metadata: Json
          operator_id: string | null
          order_no: string
          order_status: string
          paid_at: string | null
          payment_status: string
          pos_shift_id: string | null
          provider_transaction_id: string | null
          recipient_name: string | null
          recipient_phone: string | null
          reservation_expires_at: string
          sale_location_id: string | null
          shipping_address: Json | null
          shipping_fee: number
          source_channel: string
          subtotal: number
          total_amount: number
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "commerce_orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      commerce_create_order_v2: {
        Args: {
          p_courier_provider: string
          p_courier_service_code: string
          p_courier_service_name?: string
          p_customer_note?: string
          p_idempotency_key: string
          p_items: Json
          p_quote_snapshot?: Json
          p_recipient_name: string
          p_recipient_phone: string
          p_shipping_address: Json
          p_shipping_fee?: number
          p_user_id: string
        }
        Returns: {
          authorization_id: string | null
          benefit_snapshot: Json
          cancelled_at: string | null
          completed_at: string | null
          courier_provider: string | null
          courier_quote_snapshot: Json | null
          courier_service_code: string | null
          courier_service_name: string | null
          created_at: string
          currency: string
          customer_id: string | null
          customer_note: string | null
          discount_snapshot: Json
          discount_total: number
          fulfillment_method: string
          id: string
          idempotency_key: string
          metadata: Json
          operator_id: string | null
          order_no: string
          order_status: string
          paid_at: string | null
          payment_status: string
          pos_shift_id: string | null
          provider_transaction_id: string | null
          recipient_name: string | null
          recipient_phone: string | null
          reservation_expires_at: string
          sale_location_id: string | null
          shipping_address: Json | null
          shipping_fee: number
          source_channel: string
          subtotal: number
          total_amount: number
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "commerce_orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      commerce_listing_availability: {
        Args: { p_listing_ids: string[] }
        Returns: {
          available_qty: number
          listing_id: string
          product_type: string
        }[]
      }
      commerce_mark_order_paid: {
        Args: {
          p_order_id: string
          p_paid_at?: string
          p_provider_transaction_id: string
        }
        Returns: {
          authorization_id: string | null
          benefit_snapshot: Json
          cancelled_at: string | null
          completed_at: string | null
          courier_provider: string | null
          courier_quote_snapshot: Json | null
          courier_service_code: string | null
          courier_service_name: string | null
          created_at: string
          currency: string
          customer_id: string | null
          customer_note: string | null
          discount_snapshot: Json
          discount_total: number
          fulfillment_method: string
          id: string
          idempotency_key: string
          metadata: Json
          operator_id: string | null
          order_no: string
          order_status: string
          paid_at: string | null
          payment_status: string
          pos_shift_id: string | null
          provider_transaction_id: string | null
          recipient_name: string | null
          recipient_phone: string | null
          reservation_expires_at: string
          sale_location_id: string | null
          shipping_address: Json | null
          shipping_fee: number
          source_channel: string
          subtotal: number
          total_amount: number
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "commerce_orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      commerce_release_expired_reservations: { Args: never; Returns: number }
      commerce_transition_after_sale: {
        Args: {
          p_after_sale_id: string
          p_approved_amount?: number
          p_next_status: string
          p_operator_id?: string
          p_rejection_reason?: string
          p_store_note?: string
        }
        Returns: {
          after_sale_no: string
          approved_amount: number | null
          assigned_to: string | null
          closed_at: string | null
          created_at: string
          evidence_urls: Json
          id: string
          inspected_at: string | null
          location_id: string
          order_id: string
          order_item_id: string
          reason_code: string
          reason_text: string | null
          received_at: string | null
          refund_requested_at: string | null
          refunded_at: string | null
          rejection_reason: string | null
          requested_amount: number
          requested_at: string
          return_carrier: string | null
          return_tracking_no: string | null
          reviewed_at: string | null
          status: string
          store_note: string | null
          type: string
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "commerce_after_sales"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      commit_sale: {
        Args: {
          p_epc?: string
          p_event_type?: string
          p_location_id?: string
          p_raw_payload?: Json
          p_sku_id: string
          p_source_channel: string
          p_source_order_id: string
          p_source_shop_id?: string
        }
        Returns: Json
      }
      fulfillment_bind_tote: {
        Args: {
          p_fulfillment_id: string
          p_location_id: string
          p_tote_code: string
        }
        Returns: {
          claimed_at: string | null
          claimed_by: string | null
          claimed_device_id: string | null
          code: string
          created_at: string
          handed_over_at: string | null
          id: string
          location_id: string
          order_id: string
          packed_at: string | null
          packing_started_at: string | null
          picked_at: string | null
          picking_started_at: string | null
          priority: number
          status: string
          tote_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "fulfillments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fulfillment_claim_task: {
        Args: {
          p_device_id: string
          p_fulfillment_id: string
          p_location_id: string
          p_operator_id?: string
        }
        Returns: {
          claimed_at: string | null
          claimed_by: string | null
          claimed_device_id: string | null
          code: string
          created_at: string
          handed_over_at: string | null
          id: string
          location_id: string
          order_id: string
          packed_at: string | null
          packing_started_at: string | null
          picked_at: string | null
          picking_started_at: string | null
          priority: number
          status: string
          tote_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "fulfillments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fulfillment_complete_pick: {
        Args: {
          p_device_id: string
          p_fulfillment_id: string
          p_location_id: string
        }
        Returns: {
          claimed_at: string | null
          claimed_by: string | null
          claimed_device_id: string | null
          code: string
          created_at: string
          handed_over_at: string | null
          id: string
          location_id: string
          order_id: string
          packed_at: string | null
          packing_started_at: string | null
          picked_at: string | null
          picking_started_at: string | null
          priority: number
          status: string
          tote_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "fulfillments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fulfillment_pick_scan: {
        Args: {
          p_client_op_id?: string
          p_code: string
          p_device_id: string
          p_fulfillment_id: string
          p_location_id: string
          p_operator_id?: string
        }
        Returns: Json
      }
      gen_commerce_after_sale_no: { Args: never; Returns: string }
      gen_commerce_order_no: { Args: never; Returns: string }
      gen_ean13: { Args: never; Returns: string }
      gen_stock_transfer_code: { Args: never; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      increment_editorial_content_share: {
        Args: { p_content_id: string }
        Returns: number
      }
      inv_apply_inbound_stock: {
        Args: { p_delta: number; p_sku_id: string }
        Returns: undefined
      }
      inv_apply_movement:
        | {
            Args: {
              p_delta: number
              p_epc: string
              p_location_id: string
              p_note: string
              p_ref_type: string
              p_sku_id: string
            }
            Returns: number
          }
        | {
            Args: {
              p_delta: number
              p_epc?: string
              p_location_id: string
              p_note?: string
              p_ref_id: string
              p_ref_type: string
              p_sku_id: string
            }
            Returns: number
          }
      inv_apply_stock_delta: {
        Args: { p_delta: number; p_sku_id: string }
        Returns: undefined
      }
      pos_complete_return: {
        Args: {
          p_authorization_id?: string
          p_client_op_id: string
          p_items: Json
          p_operator_id: string
          p_order_id: string
          p_reason: string
          p_shift_id: string
        }
        Returns: Json
      }
      pos_complete_sale: {
        Args: {
          p_client_op_id: string
          p_customer_id?: string
          p_items: Json
          p_note?: string
          p_operator_id: string
          p_shift_id: string
          p_tenders: Json
        }
        Returns: Json
      }
      pos_complete_sale_v2: {
        Args: {
          p_authorization_id?: string
          p_benefit_snapshot?: Json
          p_client_op_id: string
          p_customer_id?: string
          p_discount_snapshot?: Json
          p_items: Json
          p_note?: string
          p_operator_id: string
          p_shift_id: string
          p_tenders: Json
        }
        Returns: Json
      }
      pos_record_cash_adjustment: {
        Args: {
          p_amount: number
          p_operator_id: string
          p_reason: string
          p_shift_id: string
          p_type: string
        }
        Returns: Json
      }
      restore_after_return_inspection: {
        Args: {
          p_inspection_id: string
          p_location_id: string
          p_notes?: string
        }
        Returns: Json
      }
      sales_sku_available_qty: {
        Args: { p_location_id: string; p_sku_id: string }
        Returns: number
      }
      search_inv_skus: {
        Args: {
          p_brand_ids?: string[]
          p_facet_codes?: string[]
          p_limit?: number
          p_offset?: number
          p_primary_category?: string
          p_query?: string
        }
        Returns: {
          search_rank: number
          sku_id: string
        }[]
      }
    }
    Enums: {
      app_role:
        | "super_admin"
        | "hq_operator"
        | "store_manager"
        | "store_staff"
        | "warehouse_staff"
      editorial_content_status:
        | "draft"
        | "pending_review"
        | "scheduled"
        | "published"
        | "archived"
      editorial_content_type: "article" | "horizontal_video" | "vertical_video"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "super_admin",
        "hq_operator",
        "store_manager",
        "store_staff",
        "warehouse_staff",
      ],
      editorial_content_status: [
        "draft",
        "pending_review",
        "scheduled",
        "published",
        "archived",
      ],
      editorial_content_type: ["article", "horizontal_video", "vertical_video"],
    },
  },
} as const
