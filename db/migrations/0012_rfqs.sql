CREATE TABLE "rfq_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"rfq_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"requisition_line_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(18, 3) NOT NULL,
	"uom" text NOT NULL,
	CONSTRAINT "rfq_lines_line_no" CHECK ("rfq_lines"."line_no" BETWEEN 1 AND 200),
	CONSTRAINT "rfq_lines_description_length" CHECK (char_length("rfq_lines"."description") BETWEEN 1 AND 500),
	CONSTRAINT "rfq_lines_quantity_positive" CHECK ("rfq_lines"."quantity" > 0),
	CONSTRAINT "rfq_lines_uom_length" CHECK (char_length("rfq_lines"."uom") BETWEEN 1 AND 16)
);
--> statement-breakpoint
CREATE TABLE "rfq_suppliers" (
	"rfq_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfq_suppliers_pkey" PRIMARY KEY("rfq_id","supplier_id")
);
--> statement-breakpoint
CREATE TABLE "rfqs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" text NOT NULL,
	"requisition_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"response_due_at" timestamp with time zone NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"issued_at" timestamp with time zone,
	"issued_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rfqs_number_unique" UNIQUE("number"),
	CONSTRAINT "rfqs_number_format" CHECK ("rfqs"."number" ~ '^RFQ-[0-9]{4}-[0-9]{6}$'),
	CONSTRAINT "rfqs_title_length" CHECK (char_length("rfqs"."title") BETWEEN 1 AND 200),
	CONSTRAINT "rfqs_status" CHECK ("rfqs"."status" IN ('draft', 'issued', 'closed', 'awarded', 'cancelled')),
	CONSTRAINT "rfqs_issued_by_with_time" CHECK (("rfqs"."issued_at" IS NULL) = ("rfqs"."issued_by_user_id" IS NULL)),
	CONSTRAINT "rfqs_issued_states" CHECK (CASE "rfqs"."status" WHEN 'draft' THEN "rfqs"."issued_at" IS NULL WHEN 'cancelled' THEN true ELSE "rfqs"."issued_at" IS NOT NULL END),
	CONSTRAINT "rfqs_closed_by_with_time" CHECK (("rfqs"."closed_at" IS NULL) = ("rfqs"."closed_by_user_id" IS NULL)),
	CONSTRAINT "rfqs_closed_states" CHECK (CASE "rfqs"."status" WHEN 'closed' THEN "rfqs"."closed_at" IS NOT NULL WHEN 'awarded' THEN "rfqs"."closed_at" IS NOT NULL WHEN 'cancelled' THEN "rfqs"."closed_at" IS NULL OR "rfqs"."issued_at" IS NOT NULL ELSE "rfqs"."closed_at" IS NULL END),
	CONSTRAINT "rfqs_cancel_consistent" CHECK (("rfqs"."status" = 'cancelled') = ("rfqs"."cancelled_at" IS NOT NULL AND "rfqs"."cancelled_by_user_id" IS NOT NULL AND "rfqs"."cancel_reason" IS NOT NULL)),
	CONSTRAINT "rfqs_cancel_reason_length" CHECK ("rfqs"."cancel_reason" IS NULL OR char_length("rfqs"."cancel_reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_requisition_line_id_requisition_lines_id_fk" FOREIGN KEY ("requisition_line_id") REFERENCES "public"."requisition_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_suppliers" ADD CONSTRAINT "rfq_suppliers_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_suppliers" ADD CONSTRAINT "rfq_suppliers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_suppliers" ADD CONSTRAINT "rfq_suppliers_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_requisition_id_purchase_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."purchase_requisitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rfq_lines_rfq_line_no" ON "rfq_lines" USING btree ("rfq_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "rfq_lines_rfq_requisition_line" ON "rfq_lines" USING btree ("rfq_id","requisition_line_id");--> statement-breakpoint
CREATE INDEX "rfq_lines_requisition_line_idx" ON "rfq_lines" USING btree ("requisition_line_id");--> statement-breakpoint
CREATE INDEX "rfq_suppliers_supplier_idx" ON "rfq_suppliers" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "rfqs_requisition_idx" ON "rfqs" USING btree ("requisition_id");--> statement-breakpoint
CREATE INDEX "rfqs_status_idx" ON "rfqs" USING btree ("status");