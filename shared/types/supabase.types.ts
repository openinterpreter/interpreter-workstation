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
    PostgrestVersion: "11.2.0 (c820efb)"
  }
  public: {
    Tables: {
      action_skills: {
        Row: {
          created_at: string
          description: string | null
          id: string
          media_links: string[] | null
          name: string
          os_version: string
          public: boolean
          steps: string
          updated_at: string | null
          user_id: string
          version: number
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          media_links?: string[] | null
          name: string
          os_version: string
          public?: boolean
          steps: string
          updated_at?: string | null
          user_id: string
          version: number
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          media_links?: string[] | null
          name?: string
          os_version?: string
          public?: boolean
          steps?: string
          updated_at?: string | null
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "action_skills_user_id_fkey1"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      actions: {
        Row: {
          action_id: string
          after_ids: string[] | null
          content: Json
          created_at: string
          event: string
          expected_next_workflow_prediction: boolean | null
          path_id: string | null
          source: string
          state: Json | null
          status: string | null
          system_message: string | null
          train: boolean | null
          user_id: string
          user_prompt: string | null
          uuid: string
          version: number
          workflow_description: string | null
          workflow_id: string | null
        }
        Insert: {
          action_id: string
          after_ids?: string[] | null
          content: Json
          created_at?: string
          event: string
          expected_next_workflow_prediction?: boolean | null
          path_id?: string | null
          source: string
          state?: Json | null
          status?: string | null
          system_message?: string | null
          train?: boolean | null
          user_id: string
          user_prompt?: string | null
          uuid?: string
          version?: number
          workflow_description?: string | null
          workflow_id?: string | null
        }
        Update: {
          action_id?: string
          after_ids?: string[] | null
          content?: Json
          created_at?: string
          event?: string
          expected_next_workflow_prediction?: boolean | null
          path_id?: string | null
          source?: string
          state?: Json | null
          status?: string | null
          system_message?: string | null
          train?: boolean | null
          user_id?: string
          user_prompt?: string | null
          uuid?: string
          version?: number
          workflow_description?: string | null
          workflow_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "actions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      alpha_users: {
        Row: {
          email: string
          id: number
          name: string | null
          sent: boolean
        }
        Insert: {
          email: string
          id?: number
          name?: string | null
          sent?: boolean
        }
        Update: {
          email?: string
          id?: number
          name?: string | null
          sent?: boolean
        }
        Relationships: []
      }
      anon_dapp_traces: {
        Row: {
          created_at: string
          device_id: string
          home_dir: string
          id: number
          user_id: string | null
        }
        Insert: {
          created_at?: string
          device_id: string
          home_dir: string
          id?: number
          user_id?: string | null
        }
        Update: {
          created_at?: string
          device_id?: string
          home_dir?: string
          id?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "anon_dapp_traces_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      changelog: {
        Row: {
          created_at: string
          id: number
          mdx_content: string
          version: string
        }
        Insert: {
          created_at?: string
          id?: number
          mdx_content: string
          version: string
        }
        Update: {
          created_at?: string
          id?: number
          mdx_content?: string
          version?: string
        }
        Relationships: []
      }
      customers: {
        Row: {
          id: string
          stripe_customer_id: string | null
        }
        Insert: {
          id: string
          stripe_customer_id?: string | null
        }
        Update: {
          id?: string
          stripe_customer_id?: string | null
        }
        Relationships: []
      }
      dapp_traces: {
        Row: {
          content: string
          created_at: string
          device_metadata: Json | null
          embedding: string | null
          id: number
          raw_data: Json | null
          role: string
          trace_id: string
          user_id: string | null
        }
        Insert: {
          content: string
          created_at?: string
          device_metadata?: Json | null
          embedding?: string | null
          id?: number
          raw_data?: Json | null
          role: string
          trace_id: string
          user_id?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          device_metadata?: Json | null
          embedding?: string | null
          id?: number
          raw_data?: Json | null
          role?: string
          trace_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dapp_traces_user_id_fkey1"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      desktop_app_chats: {
        Row: {
          created_at: string
          id: string
          messages: Json | null
          tokens: number
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id: string
          messages?: Json | null
          tokens: number
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          messages?: Json | null
          tokens?: number
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "desktop_app_chats_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      desktop_user_cost: {
        Row: {
          cost: number
          created_at: string
          id: number
          metadata: Json | null
          user_id: string
        }
        Insert: {
          cost: number
          created_at?: string
          id?: number
          metadata?: Json | null
          user_id: string
        }
        Update: {
          cost?: number
          created_at?: string
          id?: number
          metadata?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "desktop_user_cost_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      desktop_user_ledger: {
        Row: {
          created_at: string
          description: string
          dollar_amount: number
          id: number
          ledger_type: string
          metadata: Json | null
          monthly_tokens: number
          purchased_tokens: number
          token_pricing_version: number
          user_id: string
        }
        Insert: {
          created_at?: string
          description: string
          dollar_amount: number
          id?: number
          ledger_type: string
          metadata?: Json | null
          monthly_tokens: number
          purchased_tokens: number
          token_pricing_version: number
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string
          dollar_amount?: number
          id?: number
          ledger_type?: string
          metadata?: Json | null
          monthly_tokens?: number
          purchased_tokens?: number
          token_pricing_version?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "desktop_user_ledger_token_pricing_version_fkey"
            columns: ["token_pricing_version"]
            isOneToOne: false
            referencedRelation: "token_pricing"
            referencedColumns: ["version"]
          },
          {
            foreignKeyName: "desktop_user_ledger_user_id_fkey1"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      desktop_user_tokens: {
        Row: {
          created_at: string
          monthly_tokens: number
          purchased_tokens: number
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          monthly_tokens: number
          purchased_tokens: number
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          monthly_tokens?: number
          purchased_tokens?: number
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "desktop_user_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      desktop_waitlist: {
        Row: {
          created_at: string
          email: string | null
          first_name: string | null
          id: number
        }
        Insert: {
          created_at?: string
          email?: string | null
          first_name?: string | null
          id?: number
        }
        Update: {
          created_at?: string
          email?: string | null
          first_name?: string | null
          id?: number
        }
        Relationships: []
      }
      error_reports: {
        Row: {
          created_at: string
          description: string | null
          email: string | null
          fixed: boolean
          id: number
          log_file_id: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          email?: string | null
          fixed?: boolean
          id?: number
          log_file_id?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          email?: string | null
          fixed?: boolean
          id?: number
          log_file_id?: string | null
        }
        Relationships: []
      }
      eval_dataset: {
        Row: {
          answer: string | null
          answerFiles: string[] | null
          batch_name: string
          created_at: string
          id: number
          question: string
          questionFiles: string[] | null
        }
        Insert: {
          answer?: string | null
          answerFiles?: string[] | null
          batch_name?: string
          created_at?: string
          id?: number
          question: string
          questionFiles?: string[] | null
        }
        Update: {
          answer?: string | null
          answerFiles?: string[] | null
          batch_name?: string
          created_at?: string
          id?: number
          question?: string
          questionFiles?: string[] | null
        }
        Relationships: []
      }
      evals: {
        Row: {
          answer: string
          answer_files: string[] | null
          created_at: string
          eval_dataset_id: number
          grade: boolean
          grader_traces: Json[]
          id: number
          model: string
          pass: number
          run_id: string
          speed: number
          tag: string | null
          traces: Json[]
        }
        Insert: {
          answer: string
          answer_files?: string[] | null
          created_at?: string
          eval_dataset_id: number
          grade: boolean
          grader_traces: Json[]
          id?: number
          model: string
          pass?: number
          run_id: string
          speed: number
          tag?: string | null
          traces: Json[]
        }
        Update: {
          answer?: string
          answer_files?: string[] | null
          created_at?: string
          eval_dataset_id?: number
          grade?: boolean
          grader_traces?: Json[]
          id?: number
          model?: string
          pass?: number
          run_id?: string
          speed?: number
          tag?: string | null
          traces?: Json[]
        }
        Relationships: [
          {
            foreignKeyName: "evals_eval_dataset_id_fkey"
            columns: ["eval_dataset_id"]
            isOneToOne: false
            referencedRelation: "eval_dataset"
            referencedColumns: ["id"]
          },
        ]
      }
      "oi-conversations": {
        Row: {
          conversation: Json | null
          conversation_id: string | null
          created_at: string
          feedback: boolean | null
          id: number
          oi_version: string | null
        }
        Insert: {
          conversation?: Json | null
          conversation_id?: string | null
          created_at?: string
          feedback?: boolean | null
          id?: number
          oi_version?: string | null
        }
        Update: {
          conversation?: Json | null
          conversation_id?: string | null
          created_at?: string
          feedback?: boolean | null
          id?: number
          oi_version?: string | null
        }
        Relationships: []
      }
      prices: {
        Row: {
          active: boolean | null
          currency: string | null
          description: string | null
          id: string
          interval: Database["public"]["Enums"]["pricing_plan_interval"] | null
          interval_count: number | null
          metadata: Json | null
          product_id: string | null
          trial_period_days: number | null
          type: Database["public"]["Enums"]["pricing_type"] | null
          unit_amount: number | null
        }
        Insert: {
          active?: boolean | null
          currency?: string | null
          description?: string | null
          id: string
          interval?: Database["public"]["Enums"]["pricing_plan_interval"] | null
          interval_count?: number | null
          metadata?: Json | null
          product_id?: string | null
          trial_period_days?: number | null
          type?: Database["public"]["Enums"]["pricing_type"] | null
          unit_amount?: number | null
        }
        Update: {
          active?: boolean | null
          currency?: string | null
          description?: string | null
          id?: string
          interval?: Database["public"]["Enums"]["pricing_plan_interval"] | null
          interval_count?: number | null
          metadata?: Json | null
          product_id?: string | null
          trial_period_days?: number | null
          type?: Database["public"]["Enums"]["pricing_type"] | null
          unit_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "prices_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      procedures: {
        Row: {
          created_at: string
          id: number
          text: string | null
        }
        Insert: {
          created_at?: string
          id?: number
          text?: string | null
        }
        Update: {
          created_at?: string
          id?: number
          text?: string | null
        }
        Relationships: []
      }
      products: {
        Row: {
          active: boolean | null
          description: string | null
          id: string
          image: string | null
          metadata: Json | null
          name: string | null
        }
        Insert: {
          active?: boolean | null
          description?: string | null
          id: string
          image?: string | null
          metadata?: Json | null
          name?: string | null
        }
        Update: {
          active?: boolean | null
          description?: string | null
          id?: string
          image?: string | null
          metadata?: Json | null
          name?: string | null
        }
        Relationships: []
      }
      skill_library: {
        Row: {
          content: string
          description: string | null
          extension: string
          input: Json | null
          name: string
          required_permissions: Json | null
          skill_dependencies: string[] | null
        }
        Insert: {
          content: string
          description?: string | null
          extension: string
          input?: Json | null
          name: string
          required_permissions?: Json | null
          skill_dependencies?: string[] | null
        }
        Update: {
          content?: string
          description?: string | null
          extension?: string
          input?: Json | null
          name?: string
          required_permissions?: Json | null
          skill_dependencies?: string[] | null
        }
        Relationships: []
      }
      stripe_events: {
        Row: {
          amount: number
          billing_reason: string
          created_at: string
          id: number
          stripe_event_id: string
          tokens_added: number
          type: string
        }
        Insert: {
          amount: number
          billing_reason: string
          created_at?: string
          id?: number
          stripe_event_id: string
          tokens_added: number
          type: string
        }
        Update: {
          amount?: number
          billing_reason?: string
          created_at?: string
          id?: number
          stripe_event_id?: string
          tokens_added?: number
          type?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          cancel_at: string | null
          cancel_at_period_end: boolean | null
          canceled_at: string | null
          created: string
          current_period_end: string
          current_period_start: string
          ended_at: string | null
          id: string
          metadata: Json | null
          price_id: string | null
          quantity: number | null
          status: Database["public"]["Enums"]["subscription_status"] | null
          trial_end: string | null
          trial_start: string | null
          user_id: string
        }
        Insert: {
          cancel_at?: string | null
          cancel_at_period_end?: boolean | null
          canceled_at?: string | null
          created?: string
          current_period_end?: string
          current_period_start?: string
          ended_at?: string | null
          id: string
          metadata?: Json | null
          price_id?: string | null
          quantity?: number | null
          status?: Database["public"]["Enums"]["subscription_status"] | null
          trial_end?: string | null
          trial_start?: string | null
          user_id: string
        }
        Update: {
          cancel_at?: string | null
          cancel_at_period_end?: boolean | null
          canceled_at?: string | null
          created?: string
          current_period_end?: string
          current_period_start?: string
          ended_at?: string | null
          id?: string
          metadata?: Json | null
          price_id?: string | null
          quantity?: number | null
          status?: Database["public"]["Enums"]["subscription_status"] | null
          trial_end?: string | null
          trial_start?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_price_id_fkey"
            columns: ["price_id"]
            isOneToOne: false
            referencedRelation: "prices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_user_id_fkey1"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      system_messages: {
        Row: {
          content: string | null
          created_at: string
          id: number
          is_active: boolean | null
          upvotes: number | null
        }
        Insert: {
          content?: string | null
          created_at?: string
          id?: number
          is_active?: boolean | null
          upvotes?: number | null
        }
        Update: {
          content?: string | null
          created_at?: string
          id?: number
          is_active?: boolean | null
          upvotes?: number | null
        }
        Relationships: []
      }
      token_pricing: {
        Row: {
          created_at: string
          id: string
          models_meta: Json | null
          price: number
          profit_margin_percent: number
          tools_meta: Json | null
          updated_at: string | null
          version: number
        }
        Insert: {
          created_at?: string
          id?: string
          models_meta?: Json | null
          price: number
          profit_margin_percent: number
          tools_meta?: Json | null
          updated_at?: string | null
          version?: number
        }
        Update: {
          created_at?: string
          id?: string
          models_meta?: Json | null
          price?: number
          profit_margin_percent?: number
          tools_meta?: Json | null
          updated_at?: string | null
          version?: number
        }
        Relationships: []
      }
      user_recent_tabs: {
        Row: {
          first_seen_at: string
          id: string
          last_accessed_at: string
          last_action_id: string | null
          last_dom_state: Json | null
          tab_id: string
          title: string | null
          url: string | null
          user_id: string
        }
        Insert: {
          first_seen_at?: string
          id?: string
          last_accessed_at?: string
          last_action_id?: string | null
          last_dom_state?: Json | null
          tab_id: string
          title?: string | null
          url?: string | null
          user_id: string
        }
        Update: {
          first_seen_at?: string
          id?: string
          last_accessed_at?: string
          last_action_id?: string | null
          last_dom_state?: Json | null
          tab_id?: string
          title?: string | null
          url?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_recent_tabs_last_action_id_fkey"
            columns: ["last_action_id"]
            isOneToOne: false
            referencedRelation: "actions"
            referencedColumns: ["uuid"]
          },
        ]
      }
      users: {
        Row: {
          accepted_terms: boolean
          billing_address: Json | null
          email: string | null
          full_name: string | null
          id: string
          initials: string | null
          metadata: Json | null
          stripe_customer_id: string | null
          updated_at: string | null
          username: string | null
        }
        Insert: {
          accepted_terms?: boolean
          billing_address?: Json | null
          email?: string | null
          full_name?: string | null
          id: string
          initials?: string | null
          metadata?: Json | null
          stripe_customer_id?: string | null
          updated_at?: string | null
          username?: string | null
        }
        Update: {
          accepted_terms?: boolean
          billing_address?: Json | null
          email?: string | null
          full_name?: string | null
          id?: string
          initials?: string | null
          metadata?: Json | null
          stripe_customer_id?: string | null
          updated_at?: string | null
          username?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      batch_update_train_status: {
        Args: { updates: Json }
        Returns: undefined
      }
      get_prelaunch_dataset: {
        Args: Record<PropertyKey, never>
        Returns: {
          after_ids: string[]
          content: Json
          created_at: string
          element_id: string
          event: string
          expected_next_workflow_prediction: boolean
          match_slice: string
          path_id: string
          system_match_position: number
          system_message: string
          tab_id: string
          train: boolean
          url: string
          user_match_position: number
          user_prompt: string
          uuid: string
        }[]
      }
      get_typing_dataset: {
        Args: Record<PropertyKey, never>
        Returns: {
          after_ids: string[]
          content: Json
          created_at: string
          element_id: string
          event: string
          expected_next_workflow_prediction: boolean
          match_slice: string
          system_match_position: number
          system_message: string
          tab_id: string
          train: boolean
          url: string
          user_match_position: number
          user_prompt: string
          uuid: string
        }[]
      }
      gtrgm_compress: {
        Args: { "": unknown }
        Returns: unknown
      }
      gtrgm_decompress: {
        Args: { "": unknown }
        Returns: unknown
      }
      gtrgm_in: {
        Args: { "": unknown }
        Returns: unknown
      }
      gtrgm_options: {
        Args: { "": unknown }
        Returns: undefined
      }
      gtrgm_out: {
        Args: { "": unknown }
        Returns: unknown
      }
      increment_desktop_user_tokens: {
        Args: {
          more_monthly_tokens: number
          more_purchased_tokens: number
          user_to_inc: string
        }
        Returns: undefined
      }
      insert_desktop_user_ledger_entry: {
        Args: {
          description_to_write: string
          dollar_amount_to_write: number
          ledger_type_to_write: string
          metadata_to_write?: Json | null
          monthly_tokens_to_write: number
          purchased_tokens_to_write: number
          token_pricing_version_to_write: number
          user_to_write: string
        }
        Returns: undefined
      }
      set_limit: {
        Args: { "": number }
        Returns: number
      }
      show_limit: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      show_trgm: {
        Args: { "": string }
        Returns: string[]
      }
      supabase_url: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
    }
    Enums: {
      pricing_plan_interval: "day" | "week" | "month" | "year"
      pricing_type: "one_time" | "recurring"
      subscription_status:
        | "trialing"
        | "active"
        | "canceled"
        | "incomplete"
        | "incomplete_expired"
        | "past_due"
        | "unpaid"
        | "paused"
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
      pricing_plan_interval: ["day", "week", "month", "year"],
      pricing_type: ["one_time", "recurring"],
      subscription_status: [
        "trialing",
        "active",
        "canceled",
        "incomplete",
        "incomplete_expired",
        "past_due",
        "unpaid",
        "paused",
      ],
    },
  },
} as const
