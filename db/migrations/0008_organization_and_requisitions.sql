CREATE TABLE "idempotency_keys" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("user_id","key"),
	CONSTRAINT "idempotency_keys_key_format" CHECK ("idempotency_keys"."key" ~ '^[A-Za-z0-9_-]{8,100}$'),
	CONSTRAINT "idempotency_keys_request_hash_format" CHECK ("idempotency_keys"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_type" text NOT NULL,
	"version_no" integer NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "approval_policies_document_type" CHECK ("approval_policies"."document_type" IN ('requisition', 'purchase_order')),
	CONSTRAINT "approval_policies_name_length" CHECK (char_length("approval_policies"."name") BETWEEN 1 AND 120),
	CONSTRAINT "approval_policies_version_positive" CHECK ("approval_policies"."version_no" >= 1),
	CONSTRAINT "approval_policies_active_xor_superseded" CHECK ("approval_policies"."is_active" = ("approval_policies"."superseded_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "approval_policy_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"policy_id" uuid NOT NULL,
	"rule_no" smallint NOT NULL,
	"department_id" uuid,
	"min_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"max_amount" numeric(20, 4),
	CONSTRAINT "approval_policy_rules_rule_no" CHECK ("approval_policy_rules"."rule_no" BETWEEN 1 AND 50),
	CONSTRAINT "approval_policy_rules_min_non_negative" CHECK ("approval_policy_rules"."min_amount" >= 0),
	CONSTRAINT "approval_policy_rules_band" CHECK ("approval_policy_rules"."max_amount" IS NULL OR "approval_policy_rules"."max_amount" > "approval_policy_rules"."min_amount")
);
--> statement-breakpoint
CREATE TABLE "approval_policy_steps" (
	"rule_id" uuid NOT NULL,
	"step_no" smallint NOT NULL,
	"required_role" text NOT NULL,
	"scope_mode" text NOT NULL,
	CONSTRAINT "approval_policy_steps_pkey" PRIMARY KEY("rule_id","step_no"),
	CONSTRAINT "approval_policy_steps_step_no" CHECK ("approval_policy_steps"."step_no" BETWEEN 1 AND 5),
	CONSTRAINT "approval_policy_steps_required_role" CHECK ("approval_policy_steps"."required_role" IN ('approver', 'finance')),
	CONSTRAINT "approval_policy_steps_scope_mode" CHECK ("approval_policy_steps"."scope_mode" IN ('document_department', 'organization')),
	CONSTRAINT "approval_policy_steps_finance_org_wide" CHECK ("approval_policy_steps"."required_role" <> 'finance' OR "approval_policy_steps"."scope_mode" = 'organization')
);
--> statement-breakpoint
CREATE TABLE "org_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"org_name" text NOT NULL,
	"timezone" text NOT NULL,
	"currency_code" text NOT NULL,
	"currency_scale" smallint NOT NULL,
	"currency_locked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "org_settings_single_row" CHECK ("org_settings"."id" = 1),
	CONSTRAINT "org_settings_org_name_length" CHECK (char_length("org_settings"."org_name") BETWEEN 1 AND 120),
	CONSTRAINT "org_settings_timezone_length" CHECK (char_length("org_settings"."timezone") BETWEEN 1 AND 64),
	CONSTRAINT "org_settings_currency_code_format" CHECK ("org_settings"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "org_settings_currency_scale_range" CHECK ("org_settings"."currency_scale" BETWEEN 0 AND 4)
);
--> statement-breakpoint
CREATE TABLE "purchase_requisitions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" text NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"title" text NOT NULL,
	"justification" text,
	"needed_by" date NOT NULL,
	"currency_code" text NOT NULL,
	"currency_scale" smallint NOT NULL,
	"estimated_total" numeric(20, 4) NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_requisitions_number_unique" UNIQUE("number"),
	CONSTRAINT "purchase_requisitions_number_format" CHECK ("purchase_requisitions"."number" ~ '^PR-[0-9]{4}-[0-9]{6}$'),
	CONSTRAINT "purchase_requisitions_title_length" CHECK (char_length("purchase_requisitions"."title") BETWEEN 1 AND 200),
	CONSTRAINT "purchase_requisitions_justification_length" CHECK ("purchase_requisitions"."justification" IS NULL OR char_length("purchase_requisitions"."justification") <= 2000),
	CONSTRAINT "purchase_requisitions_currency_code_format" CHECK ("purchase_requisitions"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "purchase_requisitions_currency_scale_range" CHECK ("purchase_requisitions"."currency_scale" BETWEEN 0 AND 4),
	CONSTRAINT "purchase_requisitions_total_non_negative" CHECK ("purchase_requisitions"."estimated_total" >= 0),
	CONSTRAINT "purchase_requisitions_status" CHECK ("purchase_requisitions"."status" IN ('draft', 'pending_approval', 'returned', 'approved', 'rejected', 'cancelled', 'closed')),
	CONSTRAINT "purchase_requisitions_cancel_consistent" CHECK (("purchase_requisitions"."status" = 'cancelled') = ("purchase_requisitions"."cancelled_at" IS NOT NULL AND "purchase_requisitions"."cancelled_by_user_id" IS NOT NULL)),
	CONSTRAINT "purchase_requisitions_cancel_reason_length" CHECK ("purchase_requisitions"."cancel_reason" IS NULL OR char_length("purchase_requisitions"."cancel_reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE "requisition_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"requisition_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(18, 3) NOT NULL,
	"uom" text NOT NULL,
	"estimated_unit_price" numeric(20, 4) NOT NULL,
	"line_total" numeric(20, 4) NOT NULL,
	"ordered_qty" numeric(18, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "requisition_lines_line_no" CHECK ("requisition_lines"."line_no" BETWEEN 1 AND 200),
	CONSTRAINT "requisition_lines_description_length" CHECK (char_length("requisition_lines"."description") BETWEEN 1 AND 500),
	CONSTRAINT "requisition_lines_quantity_positive" CHECK ("requisition_lines"."quantity" > 0),
	CONSTRAINT "requisition_lines_uom_length" CHECK (char_length("requisition_lines"."uom") BETWEEN 1 AND 16),
	CONSTRAINT "requisition_lines_price_non_negative" CHECK ("requisition_lines"."estimated_unit_price" >= 0),
	CONSTRAINT "requisition_lines_total_non_negative" CHECK ("requisition_lines"."line_total" >= 0),
	CONSTRAINT "requisition_lines_ordered_qty_range" CHECK ("requisition_lines"."ordered_qty" >= 0 AND "requisition_lines"."ordered_qty" <= "requisition_lines"."quantity")
);
--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policy_rules" ADD CONSTRAINT "approval_policy_rules_policy_id_approval_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."approval_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policy_rules" ADD CONSTRAINT "approval_policy_rules_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policy_steps" ADD CONSTRAINT "approval_policy_steps_rule_id_approval_policy_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."approval_policy_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_requisition_id_purchase_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."purchase_requisitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_policies_one_active" ON "approval_policies" USING btree ("document_type") WHERE "approval_policies"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "approval_policies_version_unique" ON "approval_policies" USING btree ("document_type","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_policy_rules_policy_rule_no" ON "approval_policy_rules" USING btree ("policy_id","rule_no");--> statement-breakpoint
CREATE INDEX "approval_policy_rules_policy_idx" ON "approval_policy_rules" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "purchase_requisitions_requester_status_idx" ON "purchase_requisitions" USING btree ("requester_user_id","status");--> statement-breakpoint
CREATE INDEX "purchase_requisitions_department_status_idx" ON "purchase_requisitions" USING btree ("department_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "requisition_lines_requisition_line_no" ON "requisition_lines" USING btree ("requisition_id","line_no");