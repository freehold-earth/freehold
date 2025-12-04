import { useState } from "react";
import type {
  PersonalContext,
  SPALPolicy,
  VerificationRequest,
} from "./types";

type Tab = "context" | "policies" | "requests";

// Demo data
const initialContext: PersonalContext = {
  birthDate: "1990-05-15",
  fullName: "Alice Demo",
};

const initialPolicies: SPALPolicy[] = [
  {
    id: "policy-1",
    name: "Age Verification Only",
    description: "Allow businesses to verify age without revealing birth date",
    rules: [
      {
        dataType: "age",
        allowedOperations: ["verify"],
        maxRetention: 0,
        allowDerivatives: false,
        requiredPayment: 0,
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const initialRequests: VerificationRequest[] = [
  {
    id: "req-1",
    type: "age",
    businessId: "biz-1",
    businessName: "The Blue Bar",
    claim: { type: "age", minAge: 18 },
    policyId: "policy-1",
    status: "pending",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 300000), // 5 min
  },
];

function App() {
  const [tab, setTab] = useState<Tab>("requests");
  const [context, setContext] = useState<PersonalContext>(initialContext);
  const [policies] = useState<SPALPolicy[]>(initialPolicies);
  const [requests, setRequests] =
    useState<VerificationRequest[]>(initialRequests);

  const pendingRequests = requests.filter((r) => r.status === "pending");

  const handleApprove = (requestId: string) => {
    setRequests((prev) =>
      prev.map((r) => (r.id === requestId ? { ...r, status: "approved" } : r))
    );
    // In real app: call PCI agent to generate ZK proof
    alert("Request approved! ZK proof would be generated and sent.");
  };

  const handleDeny = (requestId: string) => {
    setRequests((prev) =>
      prev.map((r) => (r.id === requestId ? { ...r, status: "denied" } : r))
    );
  };

  return (
    <div className="container">
      <h1>PCI User App</h1>
      <p className="subtitle">Manage your personal context and privacy</p>

      <div className="tabs">
        <button
          className={`tab ${tab === "requests" ? "active" : ""}`}
          onClick={() => setTab("requests")}
        >
          Requests {pendingRequests.length > 0 && `(${pendingRequests.length})`}
        </button>
        <button
          className={`tab ${tab === "context" ? "active" : ""}`}
          onClick={() => setTab("context")}
        >
          My Context
        </button>
        <button
          className={`tab ${tab === "policies" ? "active" : ""}`}
          onClick={() => setTab("policies")}
        >
          Policies
        </button>
      </div>

      {tab === "requests" && (
        <RequestsTab
          requests={requests}
          onApprove={handleApprove}
          onDeny={handleDeny}
        />
      )}

      {tab === "context" && (
        <ContextTab context={context} onUpdate={setContext} />
      )}

      {tab === "policies" && <PoliciesTab policies={policies} />}
    </div>
  );
}

function RequestsTab({
  requests,
  onApprove,
  onDeny,
}: {
  requests: VerificationRequest[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const pending = requests.filter((r) => r.status === "pending");
  const history = requests.filter((r) => r.status !== "pending");

  return (
    <div>
      <h2>Pending Requests</h2>
      {pending.length === 0 ? (
        <div className="card empty-state">No pending requests</div>
      ) : (
        pending.map((request) => (
          <div key={request.id} className="card">
            <div className="card-header">
              <strong>{request.businessName}</strong>
              <span className="badge badge-pending">Pending</span>
            </div>
            <div className="request-details">
              <p>
                <strong>Request:</strong>{" "}
                {request.claim.type === "age"
                  ? `Verify age is at least ${request.claim.minAge}`
                  : "Verify credential"}
              </p>
              <p>
                <strong>What they will receive:</strong>{" "}
                {request.claim.type === "age"
                  ? `"Yes/No" - user is >= ${request.claim.minAge}`
                  : "Credential validity"}
              </p>
              <p>
                <strong>What they will NOT see:</strong>{" "}
                {request.claim.type === "age"
                  ? "Your actual birth date"
                  : "Credential details"}
              </p>
            </div>
            <div className="button-group">
              <button
                className="btn-success"
                onClick={() => onApprove(request.id)}
              >
                Approve
              </button>
              <button
                className="btn-danger"
                onClick={() => onDeny(request.id)}
              >
                Deny
              </button>
            </div>
          </div>
        ))
      )}

      {history.length > 0 && (
        <>
          <h2 style={{ marginTop: "2rem" }}>History</h2>
          {history.map((request) => (
            <div key={request.id} className="card">
              <div className="card-header">
                <strong>{request.businessName}</strong>
                <span
                  className={`badge ${
                    request.status === "approved"
                      ? "badge-approved"
                      : "badge-denied"
                  }`}
                >
                  {request.status}
                </span>
              </div>
              <p>
                {request.claim.type === "age"
                  ? `Age verification (>= ${request.claim.minAge})`
                  : "Credential verification"}
              </p>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function ContextTab({
  context,
  onUpdate,
}: {
  context: PersonalContext;
  onUpdate: (ctx: PersonalContext) => void;
}) {
  return (
    <div>
      <h2>My Personal Context</h2>
      <p className="subtitle">
        This data is stored encrypted. Only you can access it.
      </p>

      <div className="card">
        <div className="form-group">
          <label>Full Name</label>
          <input
            type="text"
            value={context.fullName || ""}
            onChange={(e) => onUpdate({ ...context, fullName: e.target.value })}
          />
        </div>
        <div className="form-group">
          <label>Birth Date</label>
          <input
            type="date"
            value={context.birthDate || ""}
            onChange={(e) =>
              onUpdate({ ...context, birthDate: e.target.value })
            }
          />
        </div>
        <button className="btn-primary">Save Changes</button>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: "1rem" }}>Context Preview</h3>
        <pre
          style={{
            background: "#f1f5f9",
            padding: "1rem",
            borderRadius: "8px",
            overflow: "auto",
          }}
        >
          {JSON.stringify(context, null, 2)}
        </pre>
        <p
          style={{ marginTop: "1rem", fontSize: "0.875rem", color: "#64748b" }}
        >
          In production, this would be encrypted and only accessible by your
          agent.
        </p>
      </div>
    </div>
  );
}

function PoliciesTab({ policies }: { policies: SPALPolicy[] }) {
  return (
    <div>
      <h2>My S-PAL Policies</h2>
      <p className="subtitle">
        Define what data businesses can verify and under what conditions.
      </p>

      {policies.map((policy) => (
        <div key={policy.id} className="card">
          <div className="card-header">
            <strong>{policy.name}</strong>
          </div>
          <p>{policy.description}</p>
          <div
            style={{
              marginTop: "1rem",
              padding: "1rem",
              background: "#f8fafc",
              borderRadius: "8px",
            }}
          >
            <strong>Rules:</strong>
            <ul style={{ marginTop: "0.5rem", paddingLeft: "1.5rem" }}>
              {policy.rules.map((rule, i) => (
                <li key={i}>
                  {rule.dataType}: {rule.allowedOperations.join(", ")}
                  {rule.maxRetention === 0
                    ? " (no retention)"
                    : ` (${rule.maxRetention}s retention)`}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ))}

      <button className="btn-primary" style={{ marginTop: "1rem" }}>
        Create New Policy
      </button>
    </div>
  );
}

export default App;
