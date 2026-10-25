CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_type" text NOT NULL,
	"document_id" uuid NOT NULL,
	"round" smallint NOT NULL,
	"document_number" text NOT NULL,
	"document_title" text NOT NULL,
	"amount_snapshot" numeric(20, 4) NOT NULL,
	"currency_code" text NOT NULL,
	"currency_scale" smallint NOT NULL,
	"department_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version_no" integer NOT NULL,
	"submitted_by_user_id" uuid NOT NULL,
	"awarded_by_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "approval_requests_document_type" CHECK ("approval_requests"."document_type" IN ('requisition', 'purchase_order')),
	CONSTRAINT "approval_requests_round_positive" CHECK ("approval_requests"."round" >= 1),
	CONSTRAINT "approval_requests_document_number_length" CHECK (char_length("approval_requests"."document_number") BETWEEN 1 AND 32),
	CONSTRAINT "approval_requests_document_title_length" CHECK (char_length("approval_requests"."document_title") BETWEEN 1 AND 200),
	CONSTRAINT "approval_requests_amount_positive" CHECK ("approval_requests"."amount_snapshot" > 0),
	CONSTRAINT "approval_requests_currency_code_format" CHECK ("approval_requests"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "approval_requests_currency_scale_range" CHECK ("approval_requests"."currency_scale" BETWEEN 0 AND 4),
	CONSTRAINT "approval_requests_policy_version_positive" CHECK ("approval_requests"."policy_version_no" >= 1),
	CONSTRAINT "approval_requests_status" CHECK ("approval_requests"."status" IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
	CONSTRAINT "approval_requests_completed_consistent" CHECK (("approval_requests"."status" = 'pending') = ("approval_requests"."completed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"step_no" smallint NOT NULL,
	"required_role" text NOT NULL,
	"scope_department_id" uuid,
	"status" text DEFAULT 'waiting' NOT NULL,
	"activated_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	CONSTRAINT "approval_steps_step_no" CHECK ("approval_steps"."step_no" BETWEEN 1 AND 5),
	CONSTRAINT "approval_steps_required_role" CHECK ("approval_steps"."required_role" IN ('approver', 'finance')),
	CONSTRAINT "approval_steps_finance_org_wide" CHECK ("approval_steps"."required_role" <> 'finance' OR "approval_steps"."scope_department_id" IS NULL),
	CONSTRAINT "approval_steps_status" CHECK ("approval_steps"."status" IN ('waiting', 'pending', 'approved', 'rejected', 'returned', 'cancelled')),
	CONSTRAINT "approval_steps_activated_consistent" CHECK (CASE "approval_steps"."status" WHEN 'waiting' THEN "approval_steps"."activated_at" IS NULL WHEN 'cancelled' THEN true ELSE "approval_steps"."activated_at" IS NOT NULL END),
	CONSTRAINT "approval_steps_decided_consistent" CHECK (("approval_steps"."status" IN ('approved', 'rejected', 'returned')) = ("approval_steps"."decided_by_user_id" IS NOT NULL AND "approval_steps"."decided_at" IS NOT NULL)),
	CONSTRAINT "approval_steps_decided_at_with_decider" CHECK (("approval_steps"."decided_by_user_id" IS NULL) = ("approval_steps"."decided_at" IS NULL)),
	CONSTRAINT "approval_steps_comment_length" CHECK ("approval_steps"."comment" IS NULL OR char_length("approval_steps"."comment") BETWEEN 1 AND 2000),
	CONSTRAINT "approval_steps_comment_only_on_decision" CHECK ("approval_steps"."comment" IS NULL OR "approval_steps"."decided_by_user_id" IS NOT NULL),
	CONSTRAINT "approval_steps_comment_required" CHECK ("approval_steps"."status" NOT IN ('rejected', 'returned') OR "approval_steps"."comment" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD COLUMN "current_approval_request_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD COLUMN "closed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_policy_id_approval_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."approval_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_awarded_by_user_id_users_id_fk" FOREIGN KEY ("awarded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_scope_department_id_departments_id_fk" FOREIGN KEY ("scope_department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_document_round" ON "approval_requests" USING btree ("document_type","document_id","round");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_one_pending" ON "approval_requests" USING btree ("document_type","document_id") WHERE "approval_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "approval_steps_request_step_no" ON "approval_steps" USING btree ("approval_request_id","step_no");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_steps_distinct_deciders" ON "approval_steps" USING btree ("approval_request_id","decided_by_user_id");--> statement-breakpoint
CREATE INDEX "approval_steps_pending_idx" ON "approval_steps" USING btree ("required_role","scope_department_id") WHERE "approval_steps"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_current_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("current_approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_requisitions_status_submitted_idx" ON "purchase_requisitions" USING btree ("status","submitted_at");--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_submitted_consistent" CHECK (("purchase_requisitions"."current_approval_request_id" IS NULL) = ("purchase_requisitions"."submitted_at" IS NULL));--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_submitted_states" CHECK ("purchase_requisitions"."status" IN ('draft', 'cancelled') OR "purchase_requisitions"."current_approval_request_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_approved_states" CHECK ("purchase_requisitions"."status" NOT IN ('approved', 'closed') OR "purchase_requisitions"."approved_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_approved_at_states" CHECK ("purchase_requisitions"."approved_at" IS NULL OR "purchase_requisitions"."status" IN ('approved', 'closed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_close_consistent" CHECK (("purchase_requisitions"."status" = 'closed') = ("purchase_requisitions"."closed_at" IS NOT NULL AND "purchase_requisitions"."closed_by_user_id" IS NOT NULL AND "purchase_requisitions"."close_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_close_reason_length" CHECK ("purchase_requisitions"."close_reason" IS NULL OR char_length("purchase_requisitions"."close_reason") BETWEEN 1 AND 500);