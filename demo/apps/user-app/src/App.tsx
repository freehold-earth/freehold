import { useState, useEffect, useCallback } from "react";
import type {
  PersonalContext,
  SPALPolicy,
  VerificationRequest,
} from "./types";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8082";

type Tab = "services" | "requests" | "context" | "policies";

interface ServiceStatus {
  agent: { status: string; url: string };
  zkp: { status: string; url: string };
  cardano: { status: string; url: string; latestBlock?: number };
}

interface ServiceRequest {
  id: string;
  userId: string;
  userName: string;
  businessId: string;
  serviceType: string;
  serviceName: string;
  status: "pending" | "verification_required" | "verified" | "completed" | "denied";
  createdAt: string;
  expiresAt: string;
  verificationRequestId: string | null;
}

// Demo data for context (would be stored encrypted in real app)
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

// Demo services to request
const DEMO_SERVICES = [
  { id: "alcohol", name: "Purchase Alcohol", icon: "🍺", minAge: 21 },
  { id: "rental", name: "Rent a Car", icon: "🚗", minAge: 25 },
];

function App() {
  const [tab, setTab] = useState<Tab>("services");
  const [context, setContext] = useState<PersonalContext>(initialContext);
  const [policies] = useState<SPALPolicy[]>(initialPolicies);
  const [serviceRequests, setServiceRequests] = useState<ServiceRequest[]>([]);
  const [verificationRequests, setVerificationRequests] = useState<VerificationRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceStatus | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [serviceRes, verificationRes, statusRes] = await Promise.all([
        fetch(`${API_URL}/service-requests`),
        fetch(`${API_URL}/requests`),
        fetch(`${API_URL}/services`),
      ]);

      const serviceData = await serviceRes.json();
      const verificationData = await verificationRes.json();
      const statusData = await statusRes.json();

      setServiceRequests(serviceData.requests || []);
      setVerificationRequests(verificationData.requests || []);
      setServices(statusData);
      setError(null);
    } catch (err) {
      setError("Failed to connect to agent");
      console.error("Fetch error:", err);
    }
  }, []);

  // Poll for updates every 2 seconds
  useEffect(() => {
    const timeoutId = setTimeout(fetchData, 0);
    const interval = setInterval(fetchData, 2000);
    return () => {
      clearTimeout(timeoutId);
      clearInterval(interval);
    };
  }, [fetchData]);

  const pendingVerifications = verificationRequests.filter((r) => r.status === "pending");

  const handleRequestService = async (service: typeof DEMO_SERVICES[0]) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/service-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "demo-user",
          userName: context.fullName || "Demo User",
          businessId: "demo-business",
          serviceType: "purchase",
          serviceName: service.name,
        }),
      });
      if (res.ok) {
        await fetchData();
        setTab("requests"); // Switch to requests tab to see the flow
      } else {
        const data = await res.json();
        setError(data.error || "Failed to create request");
      }
    } catch (_err) {
      setError("Failed to connect to agent");
    }
    setLoading(false);
  };

  const handleApprove = async (requestId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/requests/${requestId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ birthDate: context.birthDate }),
      });
      if (res.ok) {
        await fetchData();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to approve");
      }
    } catch (_err) {
      setError("Failed to connect to agent");
    }
    setLoading(false);
  };

  const handleDeny = async (requestId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/requests/${requestId}/deny`, {
        method: "POST",
      });
      if (res.ok) {
        await fetchData();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to deny");
      }
    } catch (_err) {
      setError("Failed to connect to agent");
    }
    setLoading(false);
  };

  return (
    <div className="container">
      <h1>PCI User App</h1>
      <p className="subtitle">Request services and manage your privacy</p>

      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div className="tabs">
        <button
          className={`tab ${tab === "services" ? "active" : ""}`}
          onClick={() => setTab("services")}
        >
          Services
        </button>
        <button
          className={`tab ${tab === "requests" ? "active" : ""}`}
          onClick={() => setTab("requests")}
        >
          My Requests {pendingVerifications.length > 0 && `(${pendingVerifications.length})`}
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

      {tab === "services" && (
        <ServicesTab
          services={DEMO_SERVICES}
          onRequest={handleRequestService}
          loading={loading}
        />
      )}

      {tab === "requests" && (
        <RequestsTab
          serviceRequests={serviceRequests}
          verificationRequests={verificationRequests}
          onApprove={handleApprove}
          onDeny={handleDeny}
          loading={loading}
        />
      )}

      {tab === "context" && (
        <ContextTab context={context} onUpdate={setContext} />
      )}

      {tab === "policies" && <PoliciesTab policies={policies} />}

      {/* Service Status Bar */}
      {services && (
        <div className="status-bar">
          <div className="status-item">
            <span className={`status-dot ${services.agent.status === "healthy" ? "green" : "red"}`} />
            Agent
          </div>
          <div className="status-item">
            <span className={`status-dot ${services.zkp.status === "healthy" ? "green" : "red"}`} />
            Midnight ZKP
          </div>
          <div className="status-item">
            <span className={`status-dot ${services.cardano.status === "healthy" ? "green" : "red"}`} />
            Cardano {services.cardano.latestBlock && `#${services.cardano.latestBlock}`}
          </div>
        </div>
      )}
    </div>
  );
}

function ServicesTab({
  services,
  onRequest,
  loading,
}: {
  services: typeof DEMO_SERVICES;
  onRequest: (service: typeof DEMO_SERVICES[0]) => void;
  loading: boolean;
}) {
  return (
    <div>
      <h2>Request a Service</h2>
      <p className="subtitle">
        Select a service to request. The business will ask you to verify your age.
      </p>

      <div style={{ display: "grid", gap: "1rem", marginTop: "1rem" }}>
        {services.map((service) => (
          <div key={service.id} className="card" style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <span style={{ fontSize: "2rem" }}>{service.icon}</span>
            <div style={{ flex: 1 }}>
              <strong>{service.name}</strong>
              <p style={{ fontSize: "0.875rem", color: "#64748b", marginTop: "0.25rem" }}>
                Requires age {service.minAge}+
              </p>
            </div>
            <button
              className="btn-primary"
              onClick={() => onRequest(service)}
              disabled={loading}
            >
              {loading ? "..." : "Request"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function RequestsTab({
  serviceRequests,
  verificationRequests,
  onApprove,
  onDeny,
  loading,
}: {
  serviceRequests: ServiceRequest[];
  verificationRequests: VerificationRequest[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  loading: boolean;
}) {
  const pendingVerifications = verificationRequests.filter((r) => r.status === "pending");
  const activeServices = serviceRequests.filter((r) =>
    r.status === "pending" || r.status === "verification_required" || r.status === "verified"
  );
  const completedServices = serviceRequests.filter((r) =>
    r.status === "completed" || r.status === "denied"
  );

  return (
    <div>
      {/* Pending verification requests - user needs to approve/deny */}
      {pendingVerifications.length > 0 && (
        <>
          <h2>Verification Required</h2>
          <p className="subtitle">A business needs to verify your information</p>
          {pendingVerifications.map((request) => (
            <div key={request.id} className="card" style={{ borderLeft: "4px solid #f59e0b" }}>
              <div className="card-header">
                <strong>{request.businessName}</strong>
                <span className="badge badge-pending">Action Required</span>
              </div>
              <div className="request-details">
                <p>
                  <strong>Request:</strong>{" "}
                  {request.claim.type === "age"
                    ? `Verify you are at least ${request.claim.minAge} years old`
                    : "Verify your credential"}
                </p>
                <div style={{
                  background: "#fef3c7",
                  padding: "1rem",
                  borderRadius: "8px",
                  marginTop: "1rem"
                }}>
                  <p style={{ fontWeight: 600 }}>Privacy Protection:</p>
                  <p style={{ marginTop: "0.5rem" }}>
                    ✓ They will receive: Only "Yes" or "No"
                  </p>
                  <p>
                    ✗ They will NOT see: Your actual birth date
                  </p>
                </div>
              </div>
              <div className="button-group" style={{ marginTop: "1rem" }}>
                <button
                  className="btn-success"
                  onClick={() => onApprove(request.id)}
                  disabled={loading}
                >
                  {loading ? "Processing..." : "Approve (Generate ZK Proof)"}
                </button>
                <button
                  className="btn-danger"
                  onClick={() => onDeny(request.id)}
                  disabled={loading}
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {/* Active service requests */}
      <h2 style={{ marginTop: pendingVerifications.length > 0 ? "2rem" : 0 }}>
        Active Requests
      </h2>
      {activeServices.length === 0 ? (
        <div className="card empty-state">
          No active requests
          <p style={{ fontSize: "0.875rem", marginTop: "0.5rem", color: "#64748b" }}>
            Go to Services tab to request something
          </p>
        </div>
      ) : (
        activeServices.map((request) => (
          <div key={request.id} className="card">
            <div className="card-header">
              <strong>{request.serviceName}</strong>
              <span className={`badge ${
                request.status === "pending" ? "badge-pending" :
                request.status === "verification_required" ? "badge-pending" :
                "badge-approved"
              }`}>
                {request.status === "pending" && "Waiting for business..."}
                {request.status === "verification_required" && "Verification needed"}
                {request.status === "verified" && "Verified - Completing..."}
              </span>
            </div>
            <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
              Request ID: {request.id}
            </p>
            {request.status === "pending" && (
              <p style={{ marginTop: "0.5rem" }}>
                Waiting for the business to respond with verification requirements...
              </p>
            )}
            {request.status === "verification_required" && (
              <p style={{ marginTop: "0.5rem", color: "#f59e0b" }}>
                The business requires verification. Check above for pending verifications.
              </p>
            )}
            {request.status === "verified" && (
              <p style={{ marginTop: "0.5rem", color: "#16a34a" }}>
                Your proof has been verified! The business is completing your request...
              </p>
            )}
          </div>
        ))
      )}

      {/* History */}
      {completedServices.length > 0 && (
        <>
          <h2 style={{ marginTop: "2rem" }}>History</h2>
          {completedServices.map((request) => (
            <div key={request.id} className="card">
              <div className="card-header">
                <strong>{request.serviceName}</strong>
                <span
                  className={`badge ${
                    request.status === "completed"
                      ? "badge-approved"
                      : "badge-denied"
                  }`}
                >
                  {request.status}
                </span>
              </div>
              <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
                ID: {request.id}
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
  const [saved, setSaved] = useState(false);

  // Calculate current age
  const calculateAge = (birthDate: string | undefined): number | null => {
    if (!birthDate) return null;
    const birth = new Date(birthDate);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    return age;
  };

  const age = calculateAge(context.birthDate);

  const handleSave = () => {
    // In production, this would encrypt and store to context-store
    // For demo, the state is already updated via onChange
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

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
          {age !== null && (
            <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: age >= 21 ? "#16a34a" : "#dc2626" }}>
              Current age: <strong>{age}</strong> years old
              {age >= 21 ? " (eligible for 21+ services)" : " (NOT eligible for 21+ services)"}
            </p>
          )}
        </div>
        <button className="btn-primary" onClick={handleSave}>
          {saved ? "Saved!" : "Save Changes"}
        </button>
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
