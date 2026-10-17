import { useState, useEffect, useCallback, useRef } from "react";
import type { VerificationRequest } from "./types";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8082";

// The service flow (/services, /service-requests) is on by default now that
// pci-agent#17 restored the endpoints. Set VITE_ENABLE_SERVICE_FLOW=false to
// fall back to the direct business-driven verification demo.
const SERVICE_FLOW_ENABLED = import.meta.env.VITE_ENABLE_SERVICE_FLOW !== "false";

type Tab = "incoming" | "history";

interface ServiceStatus {
  agent: { status: string; url: string };
  zkp: { status: string; url: string };
  cardano: { status: string; url: string; latest_block?: number | null };
}

interface ServiceRequest {
  id: string;
  user_id: string;
  user_name: string;
  business_id: string;
  service_type: string;
  service_name: string;
  // Lifecycle: pending -> verification_required (business links a
  // verification) -> verified | denied | rejected when the user responds;
  // verified -> completed via POST /service-requests/:id/complete (repeat
  // completes are 200 idempotent). "verified" only exits while a business
  // app is polling. expires_at is advisory: the agent defines no "expired"
  // state and never enforces it.
  status: "pending" | "verification_required" | "verified" | "completed" | "denied" | "rejected";
  created_at: string;
  expires_at: string;
  verification_request_id: string | null;
  completed_at: string | null;
}

// FastAPI's `detail` is a string for HTTPException but an array of validation
// objects for 422s; only strings are safe to render.
function apiErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const { detail, error } = data as { detail?: unknown; error?: unknown };
    if (typeof detail === "string") return detail;
    if (typeof error === "string") return error;
  }
  return fallback;
}

// Service requirements - what verification is needed for each service
const SERVICE_REQUIREMENTS: Record<string, { minAge: number }> = {
  "Purchase Alcohol": { minAge: 21 },
  "Rent a Car": { minAge: 25 },
};

function App() {
  const [tab, setTab] = useState<Tab>("incoming");
  const [serviceRequests, setServiceRequests] = useState<ServiceRequest[]>([]);
  const [verificationRequests, setVerificationRequests] = useState<VerificationRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [processedRequests, setProcessedRequests] = useState<Set<string>>(new Set());
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [services, setServices] = useState<ServiceStatus | null>(null);
  // Synchronous in-flight guards: the state Sets above only update after a
  // POST resolves, so the 2s polling effect could re-fire the same POST while
  // one is still pending (the agent re-links verification_required requests
  // rather than rejecting them, so duplicates are user-visible). IDs are
  // reserved here before each fetch and released only on failure, for retry.
  const creatingIdsRef = useRef<Set<string>>(new Set());
  const completingIdsRef = useRef<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    try {
      const verificationRes = await fetch(`${API_URL}/requests`);
      if (!verificationRes.ok) {
        throw new Error(`agent responded with ${verificationRes.status}`);
      }
      const verificationData = await verificationRes.json();
      setVerificationRequests(verificationData.requests || []);

      if (SERVICE_FLOW_ENABLED) {
        const [serviceRes, statusRes] = await Promise.all([
          fetch(`${API_URL}/service-requests`),
          fetch(`${API_URL}/services`),
        ]);
        if (!serviceRes.ok || !statusRes.ok) {
          throw new Error("agent service endpoints unavailable");
        }
        setServiceRequests((await serviceRes.json()).requests || []);
        setServices(await statusRes.json());
      }

      setError(null);
    } catch (err) {
      setError("Failed to connect to agent");
      console.error("Fetch error:", err);
    }
  }, []);

  // Auto-respond to new service requests with verification requirements
  const handleNewServiceRequests = useCallback(async () => {
    const pendingRequests = serviceRequests.filter(
      (r) =>
        r.status === "pending" &&
        !processedRequests.has(r.id) &&
        !creatingIdsRef.current.has(r.id)
    );

    let responded = false;
    for (const request of pendingRequests) {
      const requirements = SERVICE_REQUIREMENTS[request.service_name];
      if (requirements) {
        creatingIdsRef.current.add(request.id);
        try {
          const res = await fetch(`${API_URL}/requests`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              business_id: "demo-business",
              business_name: "Demo Business",
              claim: { type: "age", params: { minAge: requirements.minAge } },
              service_request_id: request.id,
            }),
          });
          if (res.ok) {
            console.log(`Created verification request for service ${request.id}`);
            setProcessedRequests((prev) => new Set([...prev, request.id]));
            responded = true;
          } else {
            creatingIdsRef.current.delete(request.id);
            console.error(
              `Failed to create verification request for service ${request.id}: ${res.status}`
            );
          }
        } catch (err) {
          creatingIdsRef.current.delete(request.id);
          console.error("Failed to create verification request:", err);
        }
      }
    }
    if (responded) {
      await fetchData();
    }
  }, [serviceRequests, processedRequests, fetchData]);

  // Auto-complete verified requests
  const handleVerifiedRequests = useCallback(async () => {
    const verifiedRequests = serviceRequests.filter(
      (r) =>
        r.status === "verified" &&
        !completedIds.has(r.id) &&
        !completingIdsRef.current.has(r.id)
    );

    let completed = false;
    for (const request of verifiedRequests) {
      completingIdsRef.current.add(request.id);
      try {
        const res = await fetch(`${API_URL}/service-requests/${request.id}/complete`, {
          method: "POST",
        });
        if (res.ok) {
          console.log(`Completed service request ${request.id}`);
          setCompletedIds((prev) => new Set([...prev, request.id]));
          completed = true;
        } else {
          completingIdsRef.current.delete(request.id);
          console.error(`Failed to complete service request ${request.id}: ${res.status}`);
        }
      } catch (err) {
        completingIdsRef.current.delete(request.id);
        console.error("Failed to complete service request:", err);
      }
    }
    if (completed) {
      await fetchData();
    }
  }, [serviceRequests, completedIds, fetchData]);

  // Poll for updates every 2 seconds
  useEffect(() => {
    const timeoutId = setTimeout(fetchData, 0);
    const interval = setInterval(fetchData, 2000);
    return () => {
      clearTimeout(timeoutId);
      clearInterval(interval);
    };
  }, [fetchData]);

  // Auto-respond to new requests (service flow only)
  useEffect(() => {
    if (!SERVICE_FLOW_ENABLED) return;
    const timeoutId = setTimeout(() => {
      handleNewServiceRequests();
      handleVerifiedRequests();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [handleNewServiceRequests, handleVerifiedRequests]);

  // Direct verification request, used while the service flow is disabled
  const handleCreateVerification = async (serviceName: string, minAge: number) => {
    setCreating(true);
    try {
      const res = await fetch(`${API_URL}/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_id: "demo-business",
          business_name: "Demo Business",
          claim: { type: "age", params: { minAge } },
        }),
      });
      if (res.ok) {
        await fetchData();
        setError(null);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(apiErrorMessage(data, `Failed to request ${serviceName} verification`));
      }
    } catch (err) {
      setError("Failed to connect to agent");
      console.error("Create verification error:", err);
    } finally {
      setCreating(false);
    }
  };

  const pendingCount = SERVICE_FLOW_ENABLED
    ? serviceRequests.filter(
        (r) => r.status === "pending" || r.status === "verification_required"
      ).length
    : verificationRequests.filter(
        (r) => r.status === "pending" || r.status === "escalated"
      ).length;

  return (
    <div className="container">
      <h1>PCI Business App</h1>
      <p className="subtitle">Age-restricted services demo</p>

      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div className="tabs">
        <button
          className={`tab ${tab === "incoming" ? "active" : ""}`}
          onClick={() => setTab("incoming")}
        >
          Incoming Requests {pendingCount > 0 && `(${pendingCount})`}
        </button>
        <button
          className={`tab ${tab === "history" ? "active" : ""}`}
          onClick={() => setTab("history")}
        >
          History
        </button>
      </div>

      {tab === "incoming" && (
        <IncomingTab
          serviceRequests={serviceRequests}
          verificationRequests={verificationRequests}
          onCreateVerification={handleCreateVerification}
          creating={creating}
        />
      )}

      {tab === "history" && (
        <HistoryTab
          serviceRequests={serviceRequests}
          verificationRequests={verificationRequests}
        />
      )}

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
            Cardano {services.cardano.latest_block != null && `#${services.cardano.latest_block}`}
          </div>
        </div>
      )}
    </div>
  );
}

function IncomingTab({
  serviceRequests,
  verificationRequests,
  onCreateVerification,
  creating,
}: {
  serviceRequests: ServiceRequest[];
  verificationRequests: VerificationRequest[];
  onCreateVerification: (serviceName: string, minAge: number) => Promise<void>;
  creating: boolean;
}) {
  // With the service flow turned off, the business drives the demo by
  // sending verification requests directly.
  if (!SERVICE_FLOW_ENABLED) {
    const awaiting = verificationRequests
      .filter((v) => v.status === "pending" || v.status === "escalated")
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return (
      <div>
        <h2>Request Verification</h2>
        <div className="warning-box">
          <p>
            <strong>Privacy Notice:</strong> You will only receive yes/no verification results.
            You will NOT receive customers' actual birth dates.
          </p>
        </div>

        <div className="card">
          <p>Ask the customer to prove their age for a service:</p>
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem", flexWrap: "wrap" }}>
            {Object.entries(SERVICE_REQUIREMENTS).map(([serviceName, req]) => (
              <button
                key={serviceName}
                className="btn-primary"
                onClick={() => void onCreateVerification(serviceName, req.minAge)}
                disabled={creating}
              >
                {creating ? "..." : `${serviceName} (${req.minAge}+)`}
              </button>
            ))}
          </div>
        </div>

        <h2 style={{ marginTop: "2rem" }}>Awaiting Customer</h2>
        {awaiting.length === 0 ? (
          <div className="card empty-state">
            <p>No verification requests awaiting a response</p>
          </div>
        ) : (
          awaiting.map((verification) => (
            <div key={verification.id} className="card">
              <div className="card-header">
                <strong>
                  {verification.claim.type === "age"
                    ? `Age check (${String(verification.claim.params.minAge)}+)`
                    : `${verification.claim.type} check`}
                </strong>
                <span className="badge badge-pending">
                  {verification.status === "escalated" ? "Escalated" : "Awaiting Verification"}
                </span>
              </div>
              <p style={{ marginTop: "0.5rem" }}>
                <strong>Request ID:</strong> {verification.id}
              </p>
              <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
                {new Date(verification.created_at).toLocaleString()}
              </p>
              <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#92400e" }}>
                Waiting for customer to approve or deny...
              </p>
            </div>
          ))
        )}
      </div>
    );
  }

  const activeRequests = serviceRequests
    .filter((r) => r.status !== "completed" && r.status !== "denied" && r.status !== "rejected")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (activeRequests.length === 0) {
    return (
      <div className="card empty-state">
        <p>No incoming requests</p>
        <p style={{ fontSize: "0.875rem", marginTop: "0.5rem", color: "#64748b" }}>
          Waiting for customers to request age-restricted services...
        </p>
      </div>
    );
  }

  return (
    <div>
      <h2>Active Requests</h2>
      <div className="warning-box">
        <p>
          <strong>Privacy Notice:</strong> You will only receive yes/no verification results.
          You will NOT receive customers' actual birth dates.
        </p>
      </div>

      {activeRequests.map((request) => {
        // Find the verification request for this service request
        const verification = verificationRequests.find(
          (v) => v.service_request_id === request.id
        );

        return (
          <div key={request.id} className="card">
            <div className="card-header">
              <strong>{request.user_name}</strong>
              <span className={`badge ${
                request.status === "verified" ? "badge-verified" :
                request.status === "verification_required" ? "badge-pending" :
                "badge-pending"
              }`}>
                {request.status === "pending" && "Processing..."}
                {request.status === "verification_required" && "Awaiting Verification"}
                {request.status === "verified" && "Verified!"}
              </span>
            </div>

            <div style={{ marginTop: "1rem" }}>
              <p><strong>Service:</strong> {request.service_name}</p>
              <p><strong>Request ID:</strong> {request.id}</p>
              <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
                {new Date(request.created_at).toLocaleString()}
              </p>
            </div>

            {request.status === "pending" && (
              <div style={{
                marginTop: "1rem",
                padding: "1rem",
                background: "#f8fafc",
                borderRadius: "8px"
              }}>
                <p>Sending verification request to customer...</p>
              </div>
            )}

            {request.status === "verification_required" && verification && (
              <div style={{
                marginTop: "1rem",
                padding: "1rem",
                background: "#fef3c7",
                borderRadius: "8px"
              }}>
                <p><strong>Verification Request Sent:</strong></p>
                <p style={{ marginTop: "0.5rem" }}>
                  Asking customer to prove age is at least {String(verification.claim.params.minAge)}
                </p>
                <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#92400e" }}>
                  Waiting for customer to approve or deny...
                </p>
              </div>
            )}

            {request.status === "verified" && verification?.response && (
              <div style={{
                marginTop: "1rem",
                padding: "1rem",
                background: "#dcfce7",
                borderRadius: "8px"
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <p style={{ fontWeight: 600, color: "#166534" }}>Verification Successful!</p>
                  {verification.response.proof && (
                    <span className="proof-source midnight">ZK Proof</span>
                  )}
                </div>
                {verification.response.proof && (
                  <pre style={{
                    marginTop: "0.5rem",
                    padding: "0.5rem",
                    background: "#f0fdf4",
                    borderRadius: "4px",
                    overflow: "auto"
                  }}>
                    {JSON.stringify(
                      verification.response.proof.publicSignals ?? verification.response.proof,
                      null,
                      2
                    )}
                  </pre>
                )}
                <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#166534" }}>
                  Zero-knowledge proof verified. Customer's actual birth date was never revealed.
                </p>
                <p style={{ marginTop: "0.5rem", fontWeight: 600 }}>
                  Completing transaction...
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HistoryTab({
  serviceRequests,
  verificationRequests,
}: {
  serviceRequests: ServiceRequest[];
  verificationRequests: VerificationRequest[];
}) {
  // With the service flow turned off, history shows resolved verification
  // requests instead of completed service requests.
  if (!SERVICE_FLOW_ENABLED) {
    const resolved = verificationRequests
      .filter((v) => v.status !== "pending" && v.status !== "escalated")
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    if (resolved.length === 0) {
      return (
        <div className="card empty-state">
          <p>No resolved verifications yet</p>
        </div>
      );
    }

    return (
      <div>
        <h2>Verification History</h2>
        {resolved.map((verification) => (
          <div key={verification.id} className="card">
            <div className="card-header">
              <strong>
                {verification.claim.type === "age"
                  ? `Age check (${String(verification.claim.params.minAge)}+)`
                  : `${verification.claim.type} check`}
              </strong>
              <span className={`badge ${
                verification.status === "approved" ? "badge-verified" : "badge-rejected"
              }`}>
                {verification.status}
              </span>
            </div>
            <p><strong>Request ID:</strong> {verification.id}</p>
            <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
              {new Date(verification.created_at).toLocaleString()}
            </p>
            {verification.response?.reason && (
              <p style={{ marginTop: "0.5rem" }}>{verification.response.reason}</p>
            )}
            {verification.status === "approved" && verification.response?.proof && (
              <div className="proof-display">
                <h4>Verification Result</h4>
                <pre>
                  {JSON.stringify(
                    verification.response.proof.publicSignals ?? verification.response.proof,
                    null,
                    2
                  )}
                </pre>
                <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#166534" }}>
                  Customer's actual birth date was never revealed - only the verification result.
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  const completedRequests = serviceRequests
    .filter((r) => r.status === "completed" || r.status === "denied" || r.status === "rejected")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (completedRequests.length === 0) {
    return (
      <div className="card empty-state">
        <p>No completed transactions yet</p>
      </div>
    );
  }

  return (
    <div>
      <h2>Transaction History</h2>

      <div className="warning-box" style={{ marginBottom: "1rem" }}>
        <p>
          <strong>Demo Only:</strong> In production, S-PAL "no retention" policies would be
          enforced via smart contract collateral and on-chain audit trails. Businesses
          violating retention policies risk losing staked funds.
        </p>
      </div>

      {completedRequests.map((request) => {
        const verification = verificationRequests.find(
          (v) => v.service_request_id === request.id
        );

        return (
          <div key={request.id} className="card">
            <div className="card-header">
              <strong>{request.user_name}</strong>
              <span className={`badge ${
                request.status === "completed" ? "badge-verified" : "badge-rejected"
              }`}>
                {request.status === "rejected" ? "verification failed" : request.status}
              </span>
            </div>

            <p><strong>Service:</strong> {request.service_name}</p>
            <p><strong>Request ID:</strong> {request.id}</p>
            <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
              {new Date(request.created_at).toLocaleString()}
            </p>

            {request.status === "completed" && verification?.response && (
              <div className="proof-display">
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <h4 style={{ margin: 0 }}>Verification Result</h4>
                  {verification.response.proof && (
                    <span className="proof-source midnight">ZK Proof</span>
                  )}
                </div>
                {verification.response.proof && (
                  <pre>
                    {JSON.stringify(
                      verification.response.proof.publicSignals ?? verification.response.proof,
                      null,
                      2
                    )}
                  </pre>
                )}
                <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#166534" }}>
                  Transaction completed with zero-knowledge proof verification.
                </p>
              </div>
            )}

            {request.status === "denied" && (
              <p style={{ marginTop: "0.5rem", color: "#dc2626" }}>
                Customer denied the verification request.
              </p>
            )}

            {request.status === "rejected" && verification?.response && (
              <div style={{ marginTop: "0.5rem" }}>
                <p style={{ color: "#dc2626", fontWeight: 600 }}>
                  Verification failed - customer does not meet requirements.
                </p>
                <pre style={{
                  marginTop: "0.5rem",
                  padding: "0.5rem",
                  background: "#fef2f2",
                  borderRadius: "4px",
                  overflow: "auto"
                }}>
                  {JSON.stringify({ reason: verification.response.reason }, null, 2)}
                </pre>
                <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#991b1b" }}>
                  Customer's actual data was never revealed - only the verification result.
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default App;
