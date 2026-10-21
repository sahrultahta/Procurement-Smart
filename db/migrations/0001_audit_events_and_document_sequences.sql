CREATE TABLE "document_sequences" (
	"doc_type" text NOT NULL,
	"year" smallint NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "document_sequences_pkey" PRIMARY KEY("doc_type","year"),
	CONSTRAINT "document_sequences_doc_type_format" CHECK ("document_sequences"."doc_type" ~ '^[A-Z]{2,4}$'),
	CONSTRAINT "document_sequences_year_range" CHECK ("document_sequences"."year" = 0 OR "document_sequences"."year" BETWEEN 2000 AND 2999),
	CONSTRAINT "document_sequences_last_value_non_negative" CHECK ("document_sequences"."last_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"request_id" uuid,
	"ip" "inet",
	"user_agent" text,
	CONSTRAINT "audit_events_action_format" CHECK ("audit_events"."action" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$'),
	CONSTRAINT "audit_events_entity_type_format" CHECK ("audit_events"."entity_type" ~ '^[a-z][a-z_]{0,63}$'),
	CONSTRAINT "audit_events_entity_id_length" CHECK (char_length("audit_events"."entity_id") BETWEEN 1 AND 128),
	CONSTRAINT "audit_events_actor_user_id_length" CHECK ("audit_events"."actor_user_id" IS NULL OR char_length("audit_events"."actor_user_id") <= 128),
	CONSTRAINT "audit_events_reason_length" CHECK ("audit_events"."reason" IS NULL OR char_length("audit_events"."reason") <= 2000),
	CONSTRAINT "audit_events_user_agent_length" CHECK ("audit_events"."user_agent" IS NULL OR char_length("audit_events"."user_agent") <= 512),
	CONSTRAINT "audit_events_changes_is_object" CHECK (jsonb_typeof("audit_events"."changes") = 'object')
);
--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action","occurred_at");