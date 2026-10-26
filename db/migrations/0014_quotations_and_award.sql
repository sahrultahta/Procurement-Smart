CREATE TABLE "quotation_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"quotation_id" uuid NOT NULL,
	"rfq_line_id" uuid NOT NULL,
	"quantity" numeric(18, 3) NOT NULL,
	"unit_price" numeric(20, 4) NOT NULL,
	"line_total" numeric(20, 4) NOT NULL,
	CONSTRAINT "quotation_lines_quantity_positive" CHECK ("quotation_lines"."quantity" > 0),
	CONSTRAINT "quotation_lines_price_non_negative" CHECK ("quotation_lines"."unit_price" >= 0),
	CONSTRAINT "quotation_lines_total_non_negative" CHECK ("quotation_lines"."line_total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"rfq_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_reference" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency_code" text NOT NULL,
	"valid_until" date NOT NULL,
	"lead_time_days" smallint NOT NULL,
	"total" numeric(20, 4) NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by_user_id" uuid,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_user_id" uuid,
	"withdraw_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "quotations_status" CHECK ("quotations"."status" IN ('draft', 'submitted', 'withdrawn', 'awarded', 'not_awarded')),
	CONSTRAINT "quotations_supplier_reference_length" CHECK ("quotations"."supplier_reference" IS NULL OR char_length("quotations"."supplier_reference") BETWEEN 1 AND 100),
	CONSTRAINT "quotations_currency_code_format" CHECK ("quotations"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "quotations_lead_time_range" CHECK ("quotations"."lead_time_days" BETWEEN 0 AND 365),
	CONSTRAINT "quotations_total_non_negative" CHECK ("quotations"."total" >= 0),
	CONSTRAINT "quotations_submitted_by_with_time" CHECK (("quotations"."submitted_at" IS NULL) = ("quotations"."submitted_by_user_id" IS NULL)),
	CONSTRAINT "quotations_submitted_states" CHECK (CASE "quotations"."status" WHEN 'draft' THEN "quotations"."submitted_at" IS NULL WHEN 'withdrawn' THEN true ELSE "quotations"."submitted_at" IS NOT NULL END),
	CONSTRAINT "quotations_withdraw_consistent" CHECK (("quotations"."status" = 'withdrawn') = ("quotations"."withdrawn_at" IS NOT NULL AND "quotations"."withdrawn_by_user_id" IS NOT NULL AND "quotations"."withdraw_reason" IS NOT NULL)),
	CONSTRAINT "quotations_withdraw_reason_length" CHECK ("quotations"."withdraw_reason" IS NULL OR char_length("quotations"."withdraw_reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "rfq_required_above" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "min_quotes" smallint DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "awarded_quotation_id" uuid;--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "awarded_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "awarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "award_justification" text;--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "award_rfq_required_above" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "award_min_quotes" smallint;--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "award_valid_quotes" smallint;--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "award_below_min_quotes" boolean;--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "award_not_lowest" boolean;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_rfq_line_id_rfq_lines_id_fk" FOREIGN KEY ("rfq_line_id") REFERENCES "public"."rfq_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_withdrawn_by_user_id_users_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_invited_supplier_fk" FOREIGN KEY ("rfq_id","supplier_id") REFERENCES "public"."rfq_suppliers"("rfq_id","supplier_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quotation_lines_quotation_rfq_line" ON "quotation_lines" USING btree ("quotation_id","rfq_line_id");--> statement-breakpoint
CREATE INDEX "quotation_lines_rfq_line_idx" ON "quotation_lines" USING btree ("rfq_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_one_live_per_supplier" ON "quotations" USING btree ("rfq_id","supplier_id") WHERE "quotations"."status" <> 'withdrawn';--> statement-breakpoint
CREATE INDEX "quotations_rfq_idx" ON "quotations" USING btree ("rfq_id");--> statement-breakpoint
CREATE INDEX "quotations_supplier_idx" ON "quotations" USING btree ("supplier_id");--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_awarded_quotation_id_quotations_id_fk" FOREIGN KEY ("awarded_quotation_id") REFERENCES "public"."quotations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_awarded_by_user_id_users_id_fk" FOREIGN KEY ("awarded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_rfq_required_above_non_negative" CHECK ("org_settings"."rfq_required_above" IS NULL OR "org_settings"."rfq_required_above" >= 0);--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_min_quotes_range" CHECK ("org_settings"."min_quotes" BETWEEN 1 AND 10);--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_award_states" CHECK (CASE WHEN "rfqs"."status" = 'awarded' THEN "rfqs"."awarded_quotation_id" IS NOT NULL AND "rfqs"."awarded_by_user_id" IS NOT NULL AND "rfqs"."awarded_at" IS NOT NULL AND "rfqs"."award_min_quotes" IS NOT NULL AND "rfqs"."award_valid_quotes" IS NOT NULL AND "rfqs"."award_below_min_quotes" IS NOT NULL AND "rfqs"."award_not_lowest" IS NOT NULL ELSE "rfqs"."awarded_quotation_id" IS NULL AND "rfqs"."awarded_by_user_id" IS NULL AND "rfqs"."awarded_at" IS NULL AND "rfqs"."award_justification" IS NULL AND "rfqs"."award_rfq_required_above" IS NULL AND "rfqs"."award_min_quotes" IS NULL AND "rfqs"."award_valid_quotes" IS NULL AND "rfqs"."award_below_min_quotes" IS NULL AND "rfqs"."award_not_lowest" IS NULL END);--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_award_justification_length" CHECK ("rfqs"."award_justification" IS NULL OR char_length("rfqs"."award_justification") BETWEEN 1 AND 2000);--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_award_justified" CHECK (NOT ("rfqs"."award_below_min_quotes" OR "rfqs"."award_not_lowest") OR "rfqs"."award_justification" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_award_rule_range" CHECK (("rfqs"."award_min_quotes" IS NULL OR "rfqs"."award_min_quotes" BETWEEN 1 AND 10) AND ("rfqs"."award_valid_quotes" IS NULL OR "rfqs"."award_valid_quotes" >= 1) AND ("rfqs"."award_rfq_required_above" IS NULL OR "rfqs"."award_rfq_required_above" >= 0));