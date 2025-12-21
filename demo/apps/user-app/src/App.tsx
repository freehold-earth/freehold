import { useState, useEffect, useCallback, useRef } from "react";
import type {
  PersonalContext,
  SPALPolicy,
  VerificationRequest,
  RootIdentity,
} from "./types";
import { createContextStore, type ContextStoreClient } from "./context-store";
import {
  generateDID,
  generateEphemeralDID,
  serializeDIDKeyPair,
} from "pci-identity";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8082";

// Demo hint - shown to help testers, but user must still enter it
const DEMO_PASSWORD_HINT = "demo-password";

type Tab = "services" | "requests" | "context" | "identity" | "policies";

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

// Default context for new users
const defaultContext: PersonalContext = {
  birthDate: "1990-05-15",
  fullName: "Alice Demo",
};

const initialPolicies: SPALPolicy[] = [
  {
    id: "spal:did:pci:demo:age-verification",
    name: "Age Verification Only",
    description: "Allow businesses to verify age without revealing birth date",
    ownerDid: "did:key:z6MkuserDemo",
    contextScope: "personal/age",
    identityLinkage: {
      ephemeralRequired: true,
      proofOfRootAllowed: false,
      zkContinuityAllowed: false,
    },
    minPayment: 0,
    maxRetentionMs: 0,
    allowedOperations: ["verify"],
    derivatives: {
      training: "forbidden",
      aggregation: "forbidden",
      resale: "forbidden",
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

// Demo services to request
const DEMO_SERVICES = [
  { id: "alcohol", name: "Purchase Alcohol", icon: "🍺", minAge: 21 },
  { id: "rental", name: "Rent a Car", icon: "🚗", minAge: 25 },
];

function App() {
  // Unlock state
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [showResetOption, setShowResetOption] = useState(false);
  const contextStoreRef = useRef<ContextStoreClient | null>(null);

  // App state
  const [tab, setTab] = useState<Tab>("services");
  const [context, setContext] = useState<PersonalContext>(defaultContext);
  const [policies] = useState<SPALPolicy[]>(initialPolicies);
  const [serviceRequests, setServiceRequests] = useState<ServiceRequest[]>([]);
  const [verificationRequests, setVerificationRequests] = useState<VerificationRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceStatus | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextStoreStatus, setContextStoreStatus] = useState<"unknown" | "connected" | "error">("unknown");

  // Identity state
  const [rootIdentity, setRootIdentity] = useState<RootIdentity | null>(null);
  const [currentEphemeralDID, setCurrentEphemeralDID] = useState<string | null>(null);

  // Handle vault unlock
  const handleUnlock = async () => {
    if (!unlockPassword) {
      setUnlockError("Please enter a password");
      return;
    }

    setUnlockError(null);
    setContextLoading(true);

    try {
      // Create context store client with user's password
      const store = createContextStore("demo-user", unlockPassword);
      contextStoreRef.current = store;

      // Try to load existing context
      const stored = await store.get<PersonalContext>("personal-context");
      if (stored) {
        setContext(stored.data);
        setContextStoreStatus("connected");
      } else {
        // No existing context - save the default
        await store.put("personal-context", defaultContext);
        setContextStoreStatus("connected");
      }

      // Load or generate root identity
      const storedIdentity = await store.get<RootIdentity>("root-identity");
      if (storedIdentity) {
        setRootIdentity(storedIdentity.data);
      } else {
        // Generate new root DID on first unlock
        const newDID = await generateDID();
        const serialized = serializeDIDKeyPair(newDID);
        const identity: RootIdentity = {
          did: serialized.did,
          publicKey: serialized.publicKey,
          privateKey: serialized.privateKey,
          createdAt: serialized.createdAt,
        };
        await store.put("root-identity", identity);
        setRootIdentity(identity);
      }

      setIsUnlocked(true);
    } catch (err) {
      console.error("Failed to unlock:", err);

      // Check if this is a decryption error (wrong password)
      const isCryptoError = err instanceof Error && (
        err.name === "OperationError" ||  // WebCrypto decryption failure
        err.message.includes("operation failed") ||
        err.message.includes("decrypt") ||
        err.message.includes("tag doesn't match")  // GCM auth tag mismatch
      );

      if (isCryptoError) {
        setUnlockError("Wrong password - decryption failed");
        setShowResetOption(true);
        // Don't auto-unlock on wrong password - user needs to fix it
      } else if (err instanceof Error && err.message.includes("fetch")) {
        // Network error - context store not reachable
        setUnlockError("Context store unavailable - continuing with local storage");
        setContextStoreStatus("error");
        setIsUnlocked(true);
      } else {
        setUnlockError(err instanceof Error ? err.message : "Unknown error");
        setContextStoreStatus("error");
        setIsUnlocked(true);
      }
    } finally {
      setContextLoading(false);
    }
  };

  // Reset vault - clear all encrypted data and start fresh
  const handleResetVault = async () => {
    setContextLoading(true);
    try {
      const CONTEXT_STORE_URL = import.meta.env.VITE_CONTEXT_STORE_URL || "http://localhost:8081";
      await fetch(`${CONTEXT_STORE_URL}/entries/personal-context`, {
        method: "DELETE",
        headers: { "X-User-ID": "demo-user" },
      });
      await fetch(`${CONTEXT_STORE_URL}/entries/root-identity`, {
        method: "DELETE",
        headers: { "X-User-ID": "demo-user" },
      });
      setUnlockError(null);
      setShowResetOption(false);
      setUnlockPassword("");
    } catch (err) {
      console.error("Failed to reset vault:", err);
      setUnlockError("Failed to reset vault - try again");
    } finally {
      setContextLoading(false);
    }
  };

  // Save context to store
  const saveContext = async (newContext: PersonalContext) => {
    setContext(newContext);

    if (contextStoreRef.current && contextStoreStatus === "connected") {
      try {
        await contextStoreRef.current.put("personal-context", newContext);
      } catch (err) {
        console.error("Failed to save context:", err);
        setError("Failed to save to encrypted store");
      }
    }
  };

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
      // Generate an ephemeral DID for this verification
      const ephemeral = await generateEphemeralDID();
      setCurrentEphemeralDID(ephemeral.did);

      const res = await fetch(`${API_URL}/requests/${requestId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          birthDate: context.birthDate,
          requesterDid: ephemeral.did,
        }),
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

  // Show unlock screen if not unlocked
  if (!isUnlocked) {
    return (
      <div className="container">
        <h1>PCI User App</h1>
        <p className="subtitle">Unlock your encrypted context store</p>

        <div className="card" style={{ maxWidth: "400px", margin: "2rem auto" }}>
          <h2>Unlock Vault</h2>
          <p style={{ marginBottom: "1rem", color: "#64748b" }}>
            Your data is encrypted with your password. Enter it to unlock.
          </p>

          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={unlockPassword}
              onChange={(e) => setUnlockPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
              placeholder="Enter your password"
              autoFocus
            />
          </div>

          {unlockError && (
            <div style={{ color: "#dc2626", marginBottom: "1rem" }}>
              {unlockError}
            </div>
          )}

          <button
            className="btn-primary"
            onClick={handleUnlock}
            disabled={contextLoading}
            style={{ width: "100%" }}
          >
            {contextLoading ? "Unlocking..." : "Unlock"}
          </button>

          {showResetOption && (
            <button
              onClick={handleResetVault}
              disabled={contextLoading}
              style={{
                width: "100%",
                marginTop: "0.5rem",
                padding: "0.75rem",
                background: "#fee2e2",
                border: "1px solid #fca5a5",
                borderRadius: "8px",
                color: "#b91c1c",
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              {contextLoading ? "Resetting..." : "Reset Vault (Start Fresh)"}
            </button>
          )}

          <div style={{
            marginTop: "1.5rem",
            padding: "1rem",
            background: "#f0f9ff",
            borderRadius: "8px",
            fontSize: "0.875rem"
          }}>
            <strong>Demo Tip:</strong>
            <ul style={{ margin: "0.5rem 0 0 1rem", padding: 0 }}>
              <li><strong>First time?</strong> Choose any password (e.g., <code style={{ background: "#e0f2fe", padding: "2px 6px", borderRadius: "4px" }}>{DEMO_PASSWORD_HINT}</code>)</li>
              <li><strong>Returning?</strong> Use your previous password</li>
              <li><strong>Forgot?</strong> Click "Reset Vault" above after a failed attempt</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

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
          className={`tab ${tab === "identity" ? "active" : ""}`}
          onClick={() => setTab("identity")}
        >
          Identity
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
        <ContextTab
          context={context}
          onUpdate={saveContext}
          storeStatus={contextStoreStatus}
        />
      )}

      {tab === "identity" && (
        <IdentityTab
          rootIdentity={rootIdentity}
          currentEphemeralDID={currentEphemeralDID}
        />
      )}

      {tab === "policies" && <PoliciesTab policies={policies} />}

      {/* Service Status Bar */}
      <div className="status-bar">
        <div className="status-item">
          <span className={`status-dot ${contextStoreStatus === "connected" ? "green" : contextStoreStatus === "error" ? "red" : "yellow"}`} />
          Context Store
        </div>
        {services && (
          <>
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
          </>
        )}
      </div>
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
  const completedServices = serviceRequests
    .filter((r) => r.status === "completed" || r.status === "denied" || r.status === "rejected")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

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
                  {request.status === "rejected" ? "not eligible" : request.status}
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
  storeStatus,
}: {
  context: PersonalContext;
  onUpdate: (ctx: PersonalContext) => void;
  storeStatus: "unknown" | "connected" | "error";
}) {
  const [saving, setSaving] = useState(false);
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

  const handleSave = async () => {
    setSaving(true);
    await onUpdate(context);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <h2>My Personal Context</h2>
      <p className="subtitle">
        This data is encrypted with your password. Only you can access it.
      </p>

      {storeStatus === "connected" && (
        <div style={{
          background: "#dcfce7",
          padding: "0.75rem 1rem",
          borderRadius: "8px",
          marginBottom: "1rem",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem"
        }}>
          <span style={{ color: "#16a34a" }}>🔐</span>
          <span>End-to-end encrypted • Stored locally • Only you have the key</span>
        </div>
      )}

      {storeStatus === "error" && (
        <div style={{
          background: "#fef2f2",
          padding: "0.75rem 1rem",
          borderRadius: "8px",
          marginBottom: "1rem",
          color: "#dc2626"
        }}>
          ⚠️ Context store unavailable - changes are local only
        </div>
      )}

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
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Encrypting & Saving..." : saved ? "Saved!" : "Save Changes"}
        </button>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: "1rem" }}>Context Preview (Decrypted View)</h3>
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
          This data is encrypted at rest. The server only stores encrypted blobs
          and cannot read your data.
        </p>
      </div>
    </div>
  );
}

function IdentityTab({
  rootIdentity,
  currentEphemeralDID,
}: {
  rootIdentity: RootIdentity | null;
  currentEphemeralDID: string | null;
}) {
  return (
    <div>
      <h2>My Identity</h2>
      <p className="subtitle">
        Your decentralized identity for privacy-preserving verification
      </p>

      {/* Root DID Card */}
      <div className="card">
        <div className="card-header">
          <strong>Root DID</strong>
          <span className="badge badge-approved">Persistent</span>
        </div>

        {rootIdentity ? (
          <>
            <div style={{
              background: "#f1f5f9",
              padding: "1rem",
              borderRadius: "8px",
              fontFamily: "monospace",
              fontSize: "0.875rem",
              wordBreak: "break-all",
              marginTop: "1rem",
            }}>
              {rootIdentity.did}
            </div>
            <p style={{ marginTop: "1rem", fontSize: "0.875rem", color: "#64748b" }}>
              Created: {new Date(rootIdentity.createdAt).toLocaleDateString()}
            </p>
          </>
        ) : (
          <p style={{ color: "#64748b", marginTop: "1rem" }}>
            Loading identity...
          </p>
        )}

        <div style={{
          marginTop: "1rem",
          padding: "1rem",
          background: "#fef3c7",
          borderRadius: "8px",
        }}>
          <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
            Privacy Protection
          </p>
          <p style={{ fontSize: "0.875rem" }}>
            Your root DID is <strong>never shared</strong> with businesses.
            Instead, a fresh ephemeral DID is generated for each verification,
            making your interactions unlinkable.
          </p>
        </div>
      </div>

      {/* Ephemeral DID Card */}
      <div className="card">
        <div className="card-header">
          <strong>Latest Ephemeral DID</strong>
          <span className="badge badge-pending">Per-Request</span>
        </div>

        {currentEphemeralDID ? (
          <>
            <div style={{
              background: "#f1f5f9",
              padding: "1rem",
              borderRadius: "8px",
              fontFamily: "monospace",
              fontSize: "0.875rem",
              wordBreak: "break-all",
              marginTop: "1rem",
            }}>
              {currentEphemeralDID}
            </div>
            <p style={{ marginTop: "1rem", fontSize: "0.875rem", color: "#64748b" }}>
              Used for your most recent verification request
            </p>
          </>
        ) : (
          <p style={{ color: "#64748b", marginTop: "1rem" }}>
            No verification requests yet. An ephemeral DID will be generated
            when you approve a verification request.
          </p>
        )}

        <div style={{
          marginTop: "1rem",
          padding: "1rem",
          background: "#dcfce7",
          borderRadius: "8px",
        }}>
          <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
            How Ephemeral DIDs Work
          </p>
          <ul style={{ fontSize: "0.875rem", paddingLeft: "1.5rem", marginTop: "0.5rem" }}>
            <li>Fresh keypair generated for each verification</li>
            <li>Cryptographically unlinkable to your root DID</li>
            <li>Businesses cannot correlate your requests</li>
            <li>ZK proofs are bound to the ephemeral DID</li>
          </ul>
        </div>
      </div>

      {/* Future: did:prism migration */}
      <div className="card" style={{ borderLeft: "4px solid #3b82f6" }}>
        <div className="card-header">
          <strong>Future: Cardano Anchored Identity</strong>
        </div>
        <p style={{ fontSize: "0.875rem", color: "#64748b", marginTop: "0.5rem" }}>
          Currently using <code>did:key</code> (W3C standard).
          Future versions will support <code>did:prism</code> for
          Cardano-anchored identity with on-chain attestations.
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
            <span className="badge badge-approved">Active</span>
          </div>
          <p>{policy.description}</p>

          {/* Context Scope */}
          <div style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#f0f9ff",
            borderRadius: "8px",
          }}>
            <strong>Data Scope:</strong>
            <code style={{
              marginLeft: "0.5rem",
              background: "#e0f2fe",
              padding: "2px 8px",
              borderRadius: "4px",
            }}>
              {policy.contextScope}
            </code>
          </div>

          {/* Identity Linkage */}
          <div style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#fef3c7",
            borderRadius: "8px",
          }}>
            <strong>Privacy Controls:</strong>
            <ul style={{ marginTop: "0.5rem", paddingLeft: "1.5rem" }}>
              <li>
                Ephemeral DID required: {policy.identityLinkage.ephemeralRequired ? "Yes" : "No"}
              </li>
              <li>
                Proof of root allowed: {policy.identityLinkage.proofOfRootAllowed ? "Yes" : "No"}
              </li>
              <li>
                ZK continuity allowed: {policy.identityLinkage.zkContinuityAllowed ? "Yes" : "No"}
              </li>
            </ul>
          </div>

          {/* Operations & Retention */}
          <div style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#f8fafc",
            borderRadius: "8px",
          }}>
            <strong>Access Rules:</strong>
            <ul style={{ marginTop: "0.5rem", paddingLeft: "1.5rem" }}>
              <li>
                Operations: {policy.allowedOperations.join(", ")}
              </li>
              <li>
                Retention: {policy.maxRetentionMs === 0 ? "No retention allowed" : `${policy.maxRetentionMs / 1000}s max`}
              </li>
              <li>
                Payment: {policy.minPayment === 0 ? "Free" : `${policy.minPayment} lovelace`}
              </li>
            </ul>
          </div>

          {/* Derivatives */}
          <div style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#fef2f2",
            borderRadius: "8px",
          }}>
            <strong>Derivative Use:</strong>
            <ul style={{ marginTop: "0.5rem", paddingLeft: "1.5rem" }}>
              <li>AI Training: {policy.derivatives.training}</li>
              <li>Aggregation: {policy.derivatives.aggregation}</li>
              <li>Resale: {policy.derivatives.resale}</li>
            </ul>
          </div>

          <p style={{ marginTop: "1rem", fontSize: "0.75rem", color: "#64748b" }}>
            Policy ID: {policy.id}
          </p>
        </div>
      ))}

      <button className="btn-primary" style={{ marginTop: "1rem" }}>
        Create New Policy
      </button>
    </div>
  );
}

export default App;
