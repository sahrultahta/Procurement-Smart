CREATE TABLE "goods_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"quantity" numeric(18, 3) NOT NULL,
	"note" text,
	CONSTRAINT "goods_receipt_lines_quantity_positive" CHECK ("goods_receipt_lines"."quantity" > 0),
	CONSTRAINT "goods_receipt_lines_note_length" CHECK ("goods_receipt_lines"."note" IS NULL OR char_length("goods_receipt_lines"."note") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" text NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"kind" text DEFAULT 'receipt' NOT NULL,
	"reverses_goods_receipt_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"received_on" date NOT NULL,
	"delivery_note_ref" text,
	"notes" text,
	"reason" text,
	"created_by_user_id" uuid NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "goods_receipts_number_unique" UNIQUE("number"),
	CONSTRAINT "goods_receipts_reverses_goods_receipt_id_unique" UNIQUE("reverses_goods_receipt_id"),
	CONSTRAINT "goods_receipts_number_format" CHECK ("goods_receipts"."number" ~ '^GR-[0-9]{4}-[0-9]{6}$'),
	CONSTRAINT "goods_receipts_kind" CHECK ("goods_receipts"."kind" IN ('receipt', 'reversal')),
	CONSTRAINT "goods_receipts_status" CHECK ("goods_receipts"."status" IN ('draft', 'posted', 'cancelled')),
	CONSTRAINT "goods_receipts_reversal_reference" CHECK (("goods_receipts"."kind" = 'reversal') = ("goods_receipts"."reverses_goods_receipt_id" IS NOT NULL)),
	CONSTRAINT "goods_receipts_reversal_reason" CHECK (("goods_receipts"."kind" = 'reversal') = ("goods_receipts"."reason" IS NOT NULL)),
	CONSTRAINT "goods_receipts_reason_length" CHECK ("goods_receipts"."reason" IS NULL OR char_length("goods_receipts"."reason") BETWEEN 1 AND 500),
	CONSTRAINT "goods_receipts_reversal_never_cancelled" CHECK ("goods_receipts"."kind" = 'receipt' OR "goods_receipts"."status" <> 'cancelled'),
	CONSTRAINT "goods_receipts_delivery_note_ref_length" CHECK ("goods_receipts"."delivery_note_ref" IS NULL OR char_length("goods_receipts"."delivery_note_ref") BETWEEN 1 AND 100),
	CONSTRAINT "goods_receipts_notes_length" CHECK ("goods_receipts"."notes" IS NULL OR char_length("goods_receipts"."notes") BETWEEN 1 AND 1000),
	CONSTRAINT "goods_receipts_posted_fields" CHECK (("goods_receipts"."status" = 'posted') = ("goods_receipts"."posted_at" IS NOT NULL) AND ("goods_receipts"."posted_at" IS NULL) = ("goods_receipts"."posted_by_user_id" IS NULL)),
	CONSTRAINT "goods_receipts_cancelled_fields" CHECK (("goods_receipts"."status" = 'cancelled') = ("goods_receipts"."cancelled_at" IS NOT NULL) AND ("goods_receipts"."cancelled_at" IS NULL) = ("goods_receipts"."cancelled_by_user_id" IS NULL)),
	CONSTRAINT "goods_receipts_cancel_reason" CHECK ("goods_receipts"."cancel_reason" IS NULL OR ("goods_receipts"."status" = 'cancelled' AND char_length("goods_receipts"."cancel_reason") BETWEEN 1 AND 500))
);
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_reverses_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("reverses_goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_lines_receipt_po_line" ON "goods_receipt_lines" USING btree ("goods_receipt_id","purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_po_line_idx" ON "goods_receipt_lines" USING btree ("purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_purchase_order_idx" ON "goods_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_status_idx" ON "goods_receipts" USING btree ("status");