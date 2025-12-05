import { useState, useEffect, useCallback } from "react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8082";

type Tab = "incoming" | "history";

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
  status: "pending" | "verification_required" | "verified" | "completed" | "denied" | "rejected";
  createdAt: string;
  expiresAt: string;
  verificationRequestId: string | null;
}

interface VerificationRequest {
  id: string;
  type: string;
  businessId: string;
  businessName: string;
  claim: { type: string; minAge?: number };
  status: "pending" | "approved" | "denied" | "expired";
  serviceRequestId?: string;
  response?: {
    verified: boolean;
    publicSignals?: Record<string, unknown>;
    proof?: unknown;
    source?: "midnight" | "fallback";
  };
  createdAt: string;
  expiresAt: string;
  respondedAt?: string;
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
  const [processedRequests, setProcessedRequests] = useState<Set<string>>(new Set());
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

  // Auto-respond to new service requests with verification requirements
  const handleNewServiceRequests = useCallback(async () => {
    const pendingRequests = serviceRequests.filter(
      (r) => r.status === "pending" && !processedRequests.has(r.id)
    );

    for (const request of pendingRequests) {
      const requirements = SERVICE_REQUIREMENTS[request.serviceName];
      if (requirements) {
        try {
          const res = await fetch(`${API_URL}/requests`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "age",
              businessId: "demo-business",
              businessName: "Demo Business",
              claim: { type: "age", minAge: requirements.minAge },
              serviceRequestId: request.id,
            }),
          });
          if (res.ok) {
            console.log(`Created verification request for service ${request.id}`);
            setProcessedRequests((prev) => new Set([...prev, request.id]));
          }
        } catch (err) {
          console.error("Failed to create verification request:", err);
        }
      }
    }
  }, [serviceRequests, processedRequests]);

  // Auto-complete verified requests
  const handleVerifiedRequests = useCallback(async () => {
    const verifiedRequests = serviceRequests.filter((r) => r.status === "verified");

    for (const request of verifiedRequests) {
      try {
        const res = await fetch(`${API_URL}/service-requests/${request.id}/complete`, {
          method: "POST",
        });
        if (res.ok) {
          console.log(`Completed service request ${request.id}`);
        }
      } catch (err) {
        console.error("Failed to complete service request:", err);
      }
    }
  }, [serviceRequests]);

  // Poll for updates every 2 seconds
  useEffect(() => {
    const timeoutId = setTimeout(fetchData, 0);
    const interval = setInterval(fetchData, 2000);
    return () => {
      clearTimeout(timeoutId);
      clearInterval(interval);
    };
  }, [fetchData]);

  // Auto-respond to new requests
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      handleNewServiceRequests();
      handleVerifiedRequests();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [handleNewServiceRequests, handleVerifiedRequests]);

  const pendingCount = serviceRequests.filter(
    (r) => r.status === "pending" || r.status === "verification_required"
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
            Cardano {services.cardano.latestBlock && `#${services.cardano.latestBlock}`}
          </div>
        </div>
      )}
    </div>
  );
}

function IncomingTab({
  serviceRequests,
  verificationRequests,
}: {
  serviceRequests: ServiceRequest[];
  verificationRequests: VerificationRequest[];
}) {
  const activeRequests = serviceRequests
    .filter((r) => r.status !== "completed" && r.status !== "denied")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

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
          (v) => v.serviceRequestId === request.id
        );

        return (
          <div key={request.id} className="card">
            <div className="card-header">
              <strong>{request.userName}</strong>
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
              <p><strong>Service:</strong> {request.serviceName}</p>
              <p><strong>Request ID:</strong> {request.id}</p>
              <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
                {new Date(request.createdAt).toLocaleString()}
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
                  Asking customer to prove age is at least {verification.claim.minAge}
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
                  {verification.response.source && (
                    <span className={`proof-source ${verification.response.source}`}>
                      {verification.response.source === "midnight" ? "Midnight ZKP" : "Fallback"}
                    </span>
                  )}
                </div>
                <pre style={{
                  marginTop: "0.5rem",
                  padding: "0.5rem",
                  background: "#f0fdf4",
                  borderRadius: "4px",
                  overflow: "auto"
                }}>
                  {JSON.stringify(verification.response.publicSignals, null, 2)}
                </pre>
                <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#166534" }}>
                  {verification.response.source === "midnight"
                    ? "Real zero-knowledge proof from Midnight network. Customer's birth date was never revealed."
                    : "Zero-knowledge proof verified. Customer's actual birth date was never revealed."}
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
  const completedRequests = serviceRequests
    .filter((r) => r.status === "completed" || r.status === "denied" || r.status === "rejected")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

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
          (v) => v.serviceRequestId === request.id
        );

        return (
          <div key={request.id} className="card">
            <div className="card-header">
              <strong>{request.userName}</strong>
              <span className={`badge ${
                request.status === "completed" ? "badge-verified" : "badge-rejected"
              }`}>
                {request.status === "rejected" ? "verification failed" : request.status}
              </span>
            </div>

            <p><strong>Service:</strong> {request.serviceName}</p>
            <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
              {new Date(request.createdAt).toLocaleString()}
            </p>

            {request.status === "completed" && verification?.response && (
              <div className="proof-display">
                <h4>Verification Result</h4>
                <pre>
                  {JSON.stringify(verification.response.publicSignals, null, 2)}
                </pre>
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
                  {JSON.stringify(verification.response.publicSignals, null, 2)}
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
