import type { LoomupAccessConfig } from "@loomup/client/access";

// Start safe: signed-in users can use declared tables and private buckets.
// For workspace/project apps, switch to the `workspace-project` profile; Loomup
// will infer child-resource access through the references in loomup.schema.yaml.
export default {
  profile: "authenticated",
} satisfies LoomupAccessConfig;
