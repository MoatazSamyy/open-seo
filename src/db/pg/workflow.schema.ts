import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Durable workflow state for runtimes without Cloudflare Workflows (the Node
// runner in src/platform/node/workflows.ts). Unused on Cloudflare.

const timestampColumn = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const workflowInstances = pgTable(
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
    wakeAt: timestampColumn("wake_at"),
    leaseUntil: timestampColumn("lease_until"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("workflow_instances_workflow_instance_idx").on(
      table.workflow,
      table.instanceId,
    ),
    index("workflow_instances_status_idx").on(table.status),
  ],
);

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: text("id").primaryKey(),
    instancePk: text("instance_pk")
      .notNull()
      .references(() => workflowInstances.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // JSON of { value }, so an undefined result round-trips too.
    result: text("result"),
    wakeAt: timestampColumn("wake_at"),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => [
    uniqueIndex("workflow_steps_instance_name_idx").on(
      table.instancePk,
      table.name,
    ),
  ],
);
