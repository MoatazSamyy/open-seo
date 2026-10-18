import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Durable workflow state for runtimes without Cloudflare Workflows (the Node
// runner in src/platform/node/workflows.ts). Unused on Cloudflare.

export const workflowInstances = sqliteTable(
  "workflow_instances",
  {
    id: text("id").primaryKey(),
    workflow: text("workflow").notNull(),
    instanceId: text("instance_id").notNull(),
    // Opaque JSON payloads, as Cloudflare Workflows stores them.
    params: text("params").notNull(),
    status: text("status").notNull(),
    errorName: text("error_name"),
    errorMessage: text("error_message"),
    output: text("output"),
    wakeAt: integer("wake_at", { mode: "timestamp_ms" }),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("workflow_instances_workflow_instance_idx").on(
      table.workflow,
      table.instanceId,
    ),
    index("workflow_instances_status_idx").on(table.status),
  ],
);

export const workflowSteps = sqliteTable(
  "workflow_steps",
  {
    id: text("id").primaryKey(),
    instancePk: text("instance_pk")
      .notNull()
      .references(() => workflowInstances.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // JSON of { value }, so an undefined result round-trips too.
    result: text("result"),
    wakeAt: integer("wake_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("workflow_steps_instance_name_idx").on(
      table.instancePk,
      table.name,
    ),
  ],
);
