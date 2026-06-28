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
      inv_skus: {
        Row: {
          barcode: string | null
          bundle_items: Json
          category: string
          created_at: string
          epc: string
          grade: string | null
          id: string
          image_url: string | null
          is_custom_price: boolean
          kind: string
          name: string
          notes: string | null
          pack_pieces: number | null
          price_tier: number
          sku_code: string | null
          status: string
          stock_qty: number
          updated_at: string
          weight_g: number | null
        }
        Insert: {
          barcode?: string | null
          bundle_items?: Json
          category: string
          created_at?: string
          epc: string
          grade?: string | null
          id?: string
          image_url?: string | null
          is_custom_price?: boolean
          kind?: string
          name: string
          notes?: string | null
          pack_pieces?: number | null
          price_tier: number
          sku_code?: string | null
          status?: string
          stock_qty?: number
          updated_at?: string
          weight_g?: number | null
        }
        Update: {
          barcode?: string | null
          bundle_items?: Json
          category?: string
          created_at?: string
          epc?: string
          grade?: string | null
          id?: string
          image_url?: string | null
          is_custom_price?: boolean
          kind?: string
          name?: string
          notes?: string | null
          pack_pieces?: number | null
          price_tier?: number
          sku_code?: string | null
          status?: string
          stock_qty?: number
          updated_at?: string
          weight_g?: number | null
        }
        Relationships: []
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
      sku_youzan_links: {
        Row: {
          created_at: string
          id: string
          last_error: string | null
          last_pull_at: string | null
          last_pull_stock: number | null
          last_pushed_at: string | null
          last_pushed_stock: number | null
          shop_id: string
          sku_id: string
          status: string
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
          shop_id: string
          sku_id: string
          status?: string
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
          shop_id?: string
          sku_id?: string
          status?: string
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
          authorized_at: string | null
          created_at: string
          expires_at: string | null
          id: string
          kdt_id: number
          last_ping_at: string | null
          last_ping_msg: string | null
          last_ping_ok: boolean | null
          notes: string | null
          parent_kdt_id: number | null
          refresh_token: string | null
          role: string
          shop_name: string
          status: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          authorized_at?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          kdt_id: number
          last_ping_at?: string | null
          last_ping_msg?: string | null
          last_ping_ok?: boolean | null
          notes?: string | null
          parent_kdt_id?: number | null
          refresh_token?: string | null
          role?: string
          shop_name: string
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          authorized_at?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          kdt_id?: number
          last_ping_at?: string | null
          last_ping_msg?: string | null
          last_ping_ok?: boolean | null
          notes?: string | null
          parent_kdt_id?: number | null
          refresh_token?: string | null
          role?: string
          shop_name?: string
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      youzan_stock_sync_queue: {
        Row: {
          attempts: number
          created_at: string
          id: string
          last_error: string | null
          next_run_at: string
          reason: string
          sku_id: string
          status: string
          target_stock: number
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          next_run_at?: string
          reason?: string
          sku_id: string
          status?: string
          target_stock: number
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          next_run_at?: string
          reason?: string
          sku_id?: string
          status?: string
          target_stock?: number
          updated_at?: string
        }
        Relationships: [
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
      gen_ean13: { Args: never; Returns: string }
      gen_stock_transfer_code: { Args: never; Returns: string }
      inv_apply_inbound_stock: {
        Args: { p_delta: number; p_sku_id: string }
        Returns: undefined
      }
      inv_apply_movement: {
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
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
