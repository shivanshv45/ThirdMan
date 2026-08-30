import { PageHeader } from "@/components/ui";
import { SetupConversationFlow } from "./setup-conversation-flow";

/**
 * Layer 24-7: the setup conversation. Replaces the tedious per-agent
 * form with a plain-English request the assistant translates into a
 * proposal — every cap and capability spelled out and confirmed by the
 * merchant before anything is created. The existing manual form
 * (/dashboard/agents) is untouched and stays the precise-control path.
 */
export default function SetupConversationPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Setup conversation"
        description={'Describe what you want in your own words — e.g. "I need something to chase failed payments, and two that can talk to customers." The assistant proposes agents with real caps and capabilities; nothing is created until you confirm every one of them.'}
      />
      <SetupConversationFlow />
    </div>
  );
}
