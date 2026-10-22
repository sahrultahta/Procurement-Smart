CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"legal_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"tax_id" text,
	"tax_id_normalized" text,
	"email" text,
	"phone" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country_code" text NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"identity_changed_by_user_id" uuid,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "suppliers_code_unique" UNIQUE("code"),
	CONSTRAINT "suppliers_status" CHECK ("suppliers"."status" IN ('pending_review', 'active', 'blocked', 'inactive')),
	CONSTRAINT "suppliers_code_format" CHECK ("suppliers"."code" ~ '^SUP-[0-9]{6}$'),
	CONSTRAINT "suppliers_legal_name_length" CHECK (char_length("suppliers"."legal_name") BETWEEN 1 AND 200),
	CONSTRAINT "suppliers_normalized_name_length" CHECK (char_length("suppliers"."normalized_name") BETWEEN 1 AND 200),
	CONSTRAINT "suppliers_tax_id_pair" CHECK (("suppliers"."tax_id" IS NULL) = ("suppliers"."tax_id_normalized" IS NULL) AND ("suppliers"."tax_id" IS NULL OR char_length("suppliers"."tax_id") <= 40)),
	CONSTRAINT "suppliers_tax_id_normalized_format" CHECK ("suppliers"."tax_id_normalized" IS NULL OR "suppliers"."tax_id_normalized" ~ '^[A-Z0-9]{5,30}$'),
	CONSTRAINT "suppliers_text_lengths" CHECK (coalesce(char_length("suppliers"."email"), 0) <= 254 AND coalesce(char_length("suppliers"."phone"), 0) <= 30
        AND coalesce(char_length("suppliers"."address_line1"), 0) <= 200 AND coalesce(char_length("suppliers"."address_line2"), 0) <= 200
        AND coalesce(char_length("suppliers"."city"), 0) <= 100 AND coalesce(char_length("suppliers"."region"), 0) <= 100
        AND coalesce(char_length("suppliers"."postal_code"), 0) <= 20 AND coalesce(char_length("suppliers"."review_note"), 0) <= 2000
        AND coalesce(char_length("suppliers"."status_reason"), 0) <= 2000),
	CONSTRAINT "suppliers_country_code_format" CHECK ("suppliers"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "suppliers_review_consistent" CHECK (("suppliers"."reviewed_by_user_id" IS NULL) = ("suppliers"."reviewed_at" IS NULL)),
	CONSTRAINT "suppliers_maker_checker" CHECK ("suppliers"."reviewed_by_user_id" IS NULL OR ("suppliers"."reviewed_by_user_id" <> "suppliers"."created_by_user_id" AND "suppliers"."reviewed_by_user_id" IS DISTINCT FROM "suppliers"."identity_changed_by_user_id")),
	CONSTRAINT "suppliers_active_is_reviewed" CHECK ("suppliers"."status" <> 'active' OR "suppliers"."reviewed_by_user_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_identity_changed_by_user_id_users_id_fk" FOREIGN KEY ("identity_changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_normalized_name_live_unique" ON "suppliers" USING btree ("normalized_name") WHERE "suppliers"."status" <> 'inactive';--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_tax_id_normalized_unique" ON "suppliers" USING btree ("tax_id_normalized") WHERE "suppliers"."tax_id_normalized" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "suppliers_status_code_idx" ON "suppliers" USING btree ("status","code");