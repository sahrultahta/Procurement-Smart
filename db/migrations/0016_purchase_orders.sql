CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"requisition_line_id" uuid NOT NULL,
	"quotation_line_id" uuid,
	"description" text NOT NULL,
	"uom" text NOT NULL,
	"quantity" numeric(18, 3) NOT NULL,
	"unit_price" numeric(20, 4) NOT NULL,
	"tax_rate_pct" numeric(7, 4) NOT NULL,
	"line_subtotal" numeric(20, 4) NOT NULL,
	"line_tax" numeric(20, 4) NOT NULL,
	"line_total" numeric(20, 4) NOT NULL,
	"received_qty" numeric(18, 3) DEFAULT '0' NOT NULL,
	"max_receivable_qty" numeric(18, 3),
	CONSTRAINT "purchase_order_lines_line_no" CHECK ("purchase_order_lines"."line_no" BETWEEN 1 AND 200),
	CONSTRAINT "purchase_order_lines_description_length" CHECK (char_length("purchase_order_lines"."description") BETWEEN 1 AND 500),
	CONSTRAINT "purchase_order_lines_uom_length" CHECK (char_length("purchase_order_lines"."uom") BETWEEN 1 AND 16),
	CONSTRAINT "purchase_order_lines_quantity_positive" CHECK ("purchase_order_lines"."quantity" > 0),
	CONSTRAINT "purchase_order_lines_price_non_negative" CHECK ("purchase_order_lines"."unit_price" >= 0),
	CONSTRAINT "purchase_order_lines_tax_rate_range" CHECK ("purchase_order_lines"."tax_rate_pct" BETWEEN 0 AND 100),
	CONSTRAINT "purchase_order_lines_amounts_non_negative" CHECK ("purchase_order_lines"."line_subtotal" >= 0 AND "purchase_order_lines"."line_tax" >= 0 AND "purchase_order_lines"."line_total" >= 0),
	CONSTRAINT "purchase_order_lines_total_sum" CHECK ("purchase_order_lines"."line_total" = "purchase_order_lines"."line_subtotal" + "purchase_order_lines"."line_tax"),
	CONSTRAINT "purchase_order_lines_received_non_negative" CHECK ("purchase_order_lines"."received_qty" >= 0),
	CONSTRAINT "purchase_order_lines_max_receivable" CHECK ("purchase_order_lines"."max_receivable_qty" IS NULL OR "purchase_order_lines"."max_receivable_qty" >= "purchase_order_lines"."quantity"),
	CONSTRAINT "purchase_order_lines_received_within_max" CHECK ("purchase_order_lines"."received_qty" = 0 OR ("purchase_order_lines"."max_receivable_qty" IS NOT NULL AND "purchase_order_lines"."received_qty" <= "purchase_order_lines"."max_receivable_qty"))
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" text NOT NULL,
	"requisition_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"quotation_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency_code" text NOT NULL,
	"currency_scale" smallint NOT NULL,
	"subtotal" numeric(20, 4) NOT NULL,
	"tax_total" numeric(20, 4) NOT NULL,
	"total" numeric(20, 4) NOT NULL,
	"payment_terms" text,
	"delivery_address" text,
	"expected_delivery_date" date,
	"approval_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"approval_threshold" numeric(20, 4),
	"price_tolerance_pct" numeric(7, 4),
	"current_approval_request_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"issued_by_user_id" uuid,
	"receipt_tolerance_pct" numeric(7, 4),
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	"close_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_orders_number_unique" UNIQUE("number"),
	CONSTRAINT "purchase_orders_number_format" CHECK ("purchase_orders"."number" ~ '^PO-[0-9]{4}-[0-9]{6}$'),
	CONSTRAINT "purchase_orders_status" CHECK ("purchase_orders"."status" IN ('draft', 'pending_approval', 'approved', 'issued', 'partially_received', 'received', 'closed', 'rejected', 'cancelled')),
	CONSTRAINT "purchase_orders_currency_code_format" CHECK ("purchase_orders"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "purchase_orders_currency_scale_range" CHECK ("purchase_orders"."currency_scale" BETWEEN 0 AND 4),
	CONSTRAINT "purchase_orders_totals_non_negative" CHECK ("purchase_orders"."subtotal" >= 0 AND "purchase_orders"."tax_total" >= 0 AND "purchase_orders"."total" >= 0),
	CONSTRAINT "purchase_orders_total_sum" CHECK ("purchase_orders"."total" = "purchase_orders"."subtotal" + "purchase_orders"."tax_total"),
	CONSTRAINT "purchase_orders_payment_terms_length" CHECK ("purchase_orders"."payment_terms" IS NULL OR char_length("purchase_orders"."payment_terms") BETWEEN 1 AND 500),
	CONSTRAINT "purchase_orders_delivery_address_length" CHECK ("purchase_orders"."delivery_address" IS NULL OR char_length("purchase_orders"."delivery_address") BETWEEN 1 AND 500),
	CONSTRAINT "purchase_orders_approval_reasons_known" CHECK ("purchase_orders"."approval_reasons" <@ ARRAY['AMOUNT_THRESHOLD', 'NO_THRESHOLD', 'PRICE_VARIANCE', 'TOTAL_VARIANCE']::text[]),
	CONSTRAINT "purchase_orders_approval_threshold_non_negative" CHECK ("purchase_orders"."approval_threshold" IS NULL OR "purchase_orders"."approval_threshold" >= 0),
	CONSTRAINT "purchase_orders_price_tolerance_range" CHECK ("purchase_orders"."price_tolerance_pct" IS NULL OR "purchase_orders"."price_tolerance_pct" BETWEEN 0 AND 100),
	CONSTRAINT "purchase_orders_submitted_by_with_time" CHECK (("purchase_orders"."submitted_at" IS NULL) = ("purchase_orders"."submitted_by_user_id" IS NULL)),
	CONSTRAINT "purchase_orders_submitted_rule" CHECK (("purchase_orders"."submitted_at" IS NULL) = ("purchase_orders"."price_tolerance_pct" IS NULL)),
	CONSTRAINT "purchase_orders_threshold_with_submission" CHECK ("purchase_orders"."approval_threshold" IS NULL OR "purchase_orders"."submitted_at" IS NOT NULL),
	CONSTRAINT "purchase_orders_submitted_states" CHECK ("purchase_orders"."status" IN ('draft', 'cancelled') OR "purchase_orders"."submitted_at" IS NOT NULL),
	CONSTRAINT "purchase_orders_approval_round_states" CHECK ("purchase_orders"."status" NOT IN ('pending_approval', 'rejected') OR ("purchase_orders"."current_approval_request_id" IS NOT NULL AND cardinality("purchase_orders"."approval_reasons") > 0)),
	CONSTRAINT "purchase_orders_approved_states" CHECK (CASE WHEN "purchase_orders"."status" IN ('approved', 'issued', 'partially_received', 'received', 'closed') THEN "purchase_orders"."approved_at" IS NOT NULL WHEN "purchase_orders"."status" = 'cancelled' THEN true ELSE "purchase_orders"."approved_at" IS NULL END),
	CONSTRAINT "purchase_orders_issued_fields" CHECK (("purchase_orders"."issued_at" IS NULL) = ("purchase_orders"."issued_by_user_id" IS NULL) AND ("purchase_orders"."issued_at" IS NULL) = ("purchase_orders"."receipt_tolerance_pct" IS NULL)),
	CONSTRAINT "purchase_orders_issued_states" CHECK (CASE WHEN "purchase_orders"."status" IN ('issued', 'partially_received', 'received', 'closed') THEN "purchase_orders"."issued_at" IS NOT NULL WHEN "purchase_orders"."status" = 'cancelled' THEN true ELSE "purchase_orders"."issued_at" IS NULL END),
	CONSTRAINT "purchase_orders_receipt_tolerance_range" CHECK ("purchase_orders"."receipt_tolerance_pct" IS NULL OR "purchase_orders"."receipt_tolerance_pct" BETWEEN 0 AND 100),
	CONSTRAINT "purchase_orders_close_consistent" CHECK (("purchase_orders"."status" = 'closed') = ("purchase_orders"."closed_at" IS NOT NULL AND "purchase_orders"."closed_by_user_id" IS NOT NULL)),
	CONSTRAINT "purchase_orders_close_reason" CHECK ("purchase_orders"."close_reason" IS NULL OR ("purchase_orders"."status" = 'closed' AND char_length("purchase_orders"."close_reason") BETWEEN 1 AND 500)),
	CONSTRAINT "purchase_orders_cancel_consistent" CHECK (("purchase_orders"."status" = 'cancelled') = ("purchase_orders"."cancelled_at" IS NOT NULL AND "purchase_orders"."cancelled_by_user_id" IS NOT NULL AND "purchase_orders"."cancel_reason" IS NOT NULL)),
	CONSTRAINT "purchase_orders_cancel_reason_length" CHECK ("purchase_orders"."cancel_reason" IS NULL OR char_length("purchase_orders"."cancel_reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "po_approval_threshold" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "po_price_tolerance_pct" numeric(7, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "over_receipt_tolerance_pct" numeric(7, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_requisition_line_id_requisition_lines_id_fk" FOREIGN KEY ("requisition_line_id") REFERENCES "public"."requisition_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_quotation_line_id_quotation_lines_id_fk" FOREIGN KEY ("quotation_line_id") REFERENCES "public"."quotation_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_requisition_id_purchase_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."purchase_requisitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_current_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("current_approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_po_line_no" ON "purchase_order_lines" USING btree ("purchase_order_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_po_requisition_line" ON "purchase_order_lines" USING btree ("purchase_order_id","requisition_line_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_requisition_line_idx" ON "purchase_order_lines" USING btree ("requisition_line_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_quotation_line_idx" ON "purchase_order_lines" USING btree ("quotation_line_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_requisition_idx" ON "purchase_orders" USING btree ("requisition_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_quotation_idx" ON "purchase_orders" USING btree ("quotation_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_department_status_idx" ON "purchase_orders" USING btree ("department_id","status");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("status");--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_po_approval_threshold_non_negative" CHECK ("org_settings"."po_approval_threshold" IS NULL OR "org_settings"."po_approval_threshold" >= 0);--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_po_price_tolerance_range" CHECK ("org_settings"."po_price_tolerance_pct" BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_over_receipt_tolerance_range" CHECK ("org_settings"."over_receipt_tolerance_pct" BETWEEN 0 AND 100);