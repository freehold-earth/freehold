import { useState, useEffect, useCallback, useRef } from "react";
import type {
  PersonalContext,
  VerificationRequest,
  RootIdentity,
} from "./types";
import { createContextStore, type ContextStoreClient } from "./context-store";
import { clearVault, loadProfile, saveProfile } from "./profile";
import { API_URL, apiErrorMessage } from "./api";
import { AskBox } from "./AskBox";
import {
  type Operator,
  type StoredPolicy,
  ensureSeedPolicy,
  governs,
  listPolicies,
  policyKeyName,
} from "./policies";
import {
  auditExport,
  deleteAuthorization,
  issueAuthorizedDid,
  listAuthorizations,
  mergeAuthorizations,
} from "./authorizations";
import {
  type ApprovalAttestation,
  attestApproval,
  type DIDKeyPair,
  generateDID,
  generateEphemeralDID,
  type SerializedAuthorizationRecord,
  serializeDIDKeyPair,
  truncateDID,
} from "@freehold-earth/identity";

const DEMO_USER_ID = "demo-user";

// Demo hint - shown to help testers, but user must still enter it
const DEMO_PASSWORD_HINT = "demo-password"; // pragma: allowlist secret

type Tab = "services" | "requests" | "context" | "identity" | "policies";

type AgentVaultStatus = "unknown" | "unlocked" | "locked" | "wrong-password" | "unavailable";

/**
 * Hand the agent the vault secret so it can read the context store itself
 * when it generates a proof. The agent checks the password against a stored
 * entry before holding it, so a wrong one is refused rather than kept.
 */
async function unlockAgent(password: string): Promise<AgentVaultStatus> {
  try {
    const res = await fetch(`${API_URL}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: DEMO_USER_ID, password }),
    });
    if (res.ok) return "unlocked";
    if (res.status === 401) return "wrong-password";
    console.warn("Agent unlock failed:", res.status, await res.text().catch(() => ""));
    return "unavailable";
  } catch (err) {
    console.warn("Agent unreachable for unlock:", err);
    return "unavailable";
  }
}

const AGENT_VAULT_DOT: Record<AgentVaultStatus, "green" | "yellow" | "red"> = {
  unknown: "yellow",
  unlocked: "green",
  locked: "red",
  "wrong-password": "red",
  unavailable: "red",
};

const AGENT_VAULT_HINT: Record<AgentVaultStatus, string> = {
  unknown: "The agent has not been given the vault password yet",
  unlocked: "The agent can read the context store to generate proofs",
  locked: "The agent holds no vault password (restarted, or locked); unlock it to approve requests",
  "wrong-password": "The agent refused the password: it does not open the stored entries",
  unavailable: "The agent could not be reached, or could not reach the context store",
};

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
  /** The terms of the policy this request was made under, as the business sees them. */
  terms: Record<string, unknown>;
  terms_hash: string;
  policy_label: { name: string; description: string | null };
  completed_at: string | null;
}

// Default context for new users
const defaultContext: PersonalContext = {
  birthDate: "1990-05-15",
  fullName: "Alice Demo",
};

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
  const [agentVault, setAgentVault] = useState<AgentVaultStatus>("unknown");
  const contextStoreRef = useRef<ContextStoreClient | null>(null);

  // App state
  const [tab, setTab] = useState<Tab>("services");
  const [context, setContext] = useState<PersonalContext>(defaultContext);
  const [policies, setPolicies] = useState<StoredPolicy[]>([]);
  // The policy a service request is made under; the holder may pick another.
  const [servicePolicyKey, setServicePolicyKey] = useState<string>("");
  const [serviceRequests, setServiceRequests] = useState<ServiceRequest[]>([]);
  const [verificationRequests, setVerificationRequests] = useState<VerificationRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A standing caveat the poll must not clear, unlike error: e.g. a DID issued with no record.
  const [notice, setNotice] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceStatus | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextStoreStatus, setContextStoreStatus] = useState<"unknown" | "connected" | "error">("unknown");

  // Identity state
  const [rootIdentity, setRootIdentity] = useState<RootIdentity | null>(null);
  const [currentEphemeralDID, setCurrentEphemeralDID] = useState<string | null>(null);
  // Root-signed records of the ephemeral DIDs issued so far, newest first.
  const [authorizations, setAuthorizations] = useState<SerializedAuthorizationRecord[]>([]);
  // DIDs whose record was taken back, so a load still in flight cannot restore them.
  const undoneDidsRef = useRef(new Set<string>());

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
      const store = createContextStore(DEMO_USER_ID, unlockPassword);
      contextStoreRef.current = store;

      // Try to load the existing profile, one entry per scope
      const stored = await loadProfile(store);
      if (stored) {
        // A profile with one entry missing (a failed write) shows the default for it.
        setContext({ ...defaultContext, ...stored });
        setContextStoreStatus("connected");
      } else {
        // No profile yet - save the default
        await saveProfile(store, defaultContext);
        setContextStoreStatus("connected");
      }

      // Load or generate root identity
      const storedIdentity = await store.get<RootIdentity>("root-identity");
      let identity: RootIdentity;
      if (storedIdentity) {
        identity = storedIdentity.data;
      } else {
        // Generate new root DID on first unlock
        const serialized = serializeDIDKeyPair(await generateDID());
        identity = {
          did: serialized.did,
          publicKey: serialized.publicKey,
          privateKey: serialized.privateKey,
          createdAt: serialized.createdAt,
        };
        await store.put("root-identity", identity);
      }
      setRootIdentity(identity);
      setIsUnlocked(true);

      // The holder's policies live in the vault; seed the demo's one on a
      // fresh vault, then list what is there. The agent reads the same
      // entries when it decides, so this list is what governs.
      try {
        await ensureSeedPolicy(store, identity.did);
        setPolicies(await listPolicies(store));
      } catch (err) {
        console.warn("Could not load policies:", err);
        setNotice("Could not load your policies from the vault");
      }

      // Records are one read and one decrypt each; load them after the
      // unlock rather than holding it. Merge rather than replace, in case a
      // record was issued while the load ran; only this root's records count.
      void listAuthorizations(store)
        .then((loaded) =>
          loaded.filter(
            (r) => r.rootDid === identity.did && !undoneDidsRef.current.has(r.ephemeralDid),
          ),
        )
        .then((loaded) => setAuthorizations((current) => mergeAuthorizations(current, loaded)))
        .catch((err) => {
          console.warn("Could not load authorization records:", err);
          setNotice("Could not load your authorization records from the vault");
        });

      // The agent reads the same store server-side when it proves a claim,
      // so it needs the secret too. The vault is usable here either way, so
      // this does not hold up the unlock; the status bar shows the outcome.
      void unlockAgent(unlockPassword).then(setAgentVault);
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

  // Reset vault - clear all encrypted data and start fresh. Deleting needs
  // no password, so a client with an empty one serves; nothing is decrypted.
  const handleResetVault = async () => {
    setContextLoading(true);
    try {
      const store = createContextStore(DEMO_USER_ID, "");
      await clearVault(store); // every key, whatever its name; a policy must not outlive its owner
      setAuthorizations([]);
      setPolicies([]);
      setCurrentEphemeralDID(null);
      undoneDidsRef.current.clear();
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
        await saveProfile(contextStoreRef.current, newContext);
      } catch (err) {
        console.error("Failed to save context:", err);
        setError("Failed to save to encrypted store");
      }
    }
  };

  const fetchData = useCallback(async () => {
    try {
      const [verificationRes, healthRes] = await Promise.all([
        fetch(`${API_URL}/requests`),
        fetch(`${API_URL}/health`),
      ]);
      if (!verificationRes.ok) {
        throw new Error(`agent responded with ${verificationRes.status}`);
      }
      const verificationData = await verificationRes.json();
      setVerificationRequests(verificationData.requests || []);

      // The agent's own report of its vault wins over the unlock-time status:
      // a restart or a /lock shows as locked. A refused or failed unlock keeps
      // its more specific status. The password is never re-sent from here;
      // a /lock is deliberate, and undoing it is the user's call.
      if (healthRes.ok) {
        const health = (await healthRes.json()) as { vault?: "locked" | "unlocked" };
        if (health.vault === "unlocked") {
          setAgentVault("unlocked");
        } else if (health.vault === "locked") {
          setAgentVault((current) =>
            current === "unlocked" || current === "unknown" ? "locked" : current
          );
        }
      }

      const [serviceRes, statusRes] = await Promise.all([
        fetch(`${API_URL}/service-requests`),
        fetch(`${API_URL}/services`),
      ]);
      if (!serviceRes.ok || !statusRes.ok) {
        throw new Error("agent service endpoints unavailable");
      }
      setServiceRequests((await serviceRes.json()).requests || []);
      setServices(await statusRes.json());

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

  // Escalated requests await a human decision, same as pending ones
  const pendingVerifications = verificationRequests.filter(
    (r) => r.status === "pending" || r.status === "escalated"
  );

  const handleRequestService = async (service: typeof DEMO_SERVICES[0]) => {
    // The request is made under one of the holder's policies; the agent
    // attaches that policy's terms for the business. The holder's pick, or
    // the first policy whose rules cover the age scope the business will ask about.
    const governing =
      policies.find((p) => p.key === servicePolicyKey) ??
      policies.find((p) => governs(p.policy, "personal/age"));
    if (!governing) {
      setError("No policy in your vault governs personal/age; unlock the vault or add one");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/service-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: DEMO_USER_ID,
          user_name: context.fullName || "Demo User",
          business_id: "demo-business",
          service_type: "purchase",
          service_name: service.name,
          policy_name: policyKeyName(governing.policy),
        }),
      });
      if (res.ok) {
        await fetchData();
        setTab("requests"); // Switch to requests tab to see the flow
      } else {
        const data = await res.json().catch(() => ({}));
        setError(apiErrorMessage(data, "Failed to create request"));
      }
    } catch (_err) {
      setError("Failed to connect to agent");
    }
    setLoading(false);
  };

  // The ephemeral DID for a verification, with a root-signed record kept in
  // the vault so the DID can later be proved ours. The proof is committed to
  // this DID, and its key signs the approval so the DID is shown to be ours
  // for this request; the agent then looks for the record in the vault and
  // accepts the DID only if our root issued it. Without a vault to keep the
  // record in (store offline, or no root identity loaded) a bare ephemeral
  // DID can still be issued, but the agent will refuse the approval, which
  // the notice says. Only fields we own are signed: the business's claim
  // params are not copied into the record.
  const issueEphemeralDid = async (
    request: VerificationRequest,
  ): Promise<{ did: string; keyPair: DIDKeyPair; key?: string; undo: () => Promise<void> }> => {
    const store = contextStoreRef.current;
    if (!store || !rootIdentity || contextStoreStatus !== "connected") {
      setNotice(
        "No vault connected: no authorization record can be kept for this verification's DID, so the agent will refuse the approval until the vault is back",
      );
      const ephemeral = await generateEphemeralDID();
      return { did: ephemeral.did, keyPair: ephemeral, undo: async () => {} };
    }
    const issued = await issueAuthorizedDid(
      store,
      rootIdentity,
      `${request.claim.type} verification at ${request.business_name}`,
      {
        verificationType: request.claim.type,
        // Which terms were in force, by their hash; never the policy id,
        // which carries the root DID (the record stays private, but the
        // hash is what the business holds too, so the two can be matched).
        ...(policies.some((p) => p.termsHash === request.terms_hash)
          ? { policyHash: request.terms_hash }
          : {}),
        metadata: {
          businessId: request.business_id,
          requestId: request.id,
          requestExpiresAt: request.expires_at,
        },
      },
    );
    setAuthorizations((current) => [issued.record, ...current]);
    setNotice(null);
    // If the agent never acts on the request the record would only clutter
    // the audit trail, so the caller can take it back. The UI follows the
    // vault: the record leaves the list only once the vault no longer has it.
    const undo = async () => {
      try {
        await deleteAuthorization(store, issued.key);
      } catch (err) {
        console.warn("Could not remove the unused authorization record:", err);
        setNotice("An authorization record for a verification that did not go ahead could not be removed");
        return;
      }
      undoneDidsRef.current.add(issued.did);
      setAuthorizations((current) => current.filter((r) => r.ephemeralDid !== issued.did));
    };
    return { did: issued.did, keyPair: issued.keyPair, key: issued.key, undo };
  };

  // The export reads the vault, not the list on screen: another tab may have
  // written records, and the list is only as fresh as its last load.
  const handleExportAuthorizations = async () => {
    const store = contextStoreRef.current;
    if (!rootIdentity || !store) return;
    let records: SerializedAuthorizationRecord[];
    try {
      records = (await listAuthorizations(store)).filter((r) => r.rootDid === rootIdentity.did);
    } catch (err) {
      console.error("Could not read authorization records for export:", err);
      setError("Could not read your authorization records from the vault");
      return;
    }
    setAuthorizations(records);
    const data = JSON.stringify(auditExport(rootIdentity.did, records), null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `freehold-authorizations-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    // Revoking before the download has started loses it in some browsers.
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  };

  const handleApprove = async (requestId: string) => {
    const request = verificationRequests.find((r) => r.id === requestId);
    if (!request) {
      setError("This request is no longer listed; it may have been resolved or expired");
      return;
    }
    setLoading(true);
    // An ephemeral DID for this verification (shown in the Identity tab). A
    // failure here is the vault's, not the agent's, and is reported as such.
    let issued: { did: string; keyPair: DIDKeyPair; key?: string; undo: () => Promise<void> };
    try {
      issued = await issueEphemeralDid(request);
    } catch (err) {
      console.error("Failed to issue an ephemeral DID:", err);
      setError("Could not issue an ephemeral DID for this verification; nothing was approved");
      setLoading(false);
      return;
    }

    // The ephemeral DID goes to the agent signed by its own key over this
    // request, so the agent and then the business can tell the DID the
    // proof is for is ours. Signing is local; if it fails nothing was sent.
    let attestation: ApprovalAttestation;
    try {
      attestation = await attestApproval(requestId, issued.keyPair);
    } catch (err) {
      console.error("Failed to sign the approval:", err);
      setError("Could not sign the approval with the ephemeral DID's key; nothing was approved");
      await issued.undo();
      setLoading(false);
      return;
    }

    // The record is taken back when the agent did not use the DID: it did
    // not act (not found, already resolved or another user's, invalid, a DID
    // or signature it would not accept, a vault it could not consult), or the
    // holder's policy refused (a 403 that stored the request as denied; no
    // proof was made). A lost response or a 500 may follow a committed
    // approval, and a retry would then be refused, so then the record stays.
    // The list is refreshed whatever the answer, since a denial is final.
    let notActedOn = false;
    try {
      // No private data travels in the approve call: the agent fetches it
      // from the encrypted context store itself.
      const res = await fetch(`${API_URL}/requests/${requestId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requester_did: attestation.requesterDid,
          signature: attestation.signature,
          // Where the record is, so the agent reads one entry, not the whole scope.
          ...(issued.key ? { record_key: issued.key } : {}),
        }),
      });
      if (res.ok) {
        setCurrentEphemeralDID(issued.did);
        await fetchData();
      } else {
        notActedOn = [403, 404, 409, 422, 503].includes(res.status);
        const data = await res.json().catch(() => ({}));
        // Refresh first: a denial is stored and final, and the refresh clears
        // the error banner, so the holder-facing reason is set afterwards.
        await fetchData();
        setError(apiErrorMessage(data, "Failed to approve"));
      }
    } catch (_err) {
      setError("Failed to connect to agent");
    }
    if (notActedOn) await issued.undo();
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
        const data = await res.json().catch(() => ({}));
        setError(apiErrorMessage(data, "Failed to deny"));
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
        <h1>Freehold User App</h1>
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
      <h1>Freehold User App</h1>
      <p className="subtitle">Request services and manage your privacy</p>

      {notice && (
        <div className="notice-banner">
          {notice}
          <button onClick={() => setNotice(null)}>×</button>
        </div>
      )}
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
          policies={policies}
          policyKey={
            servicePolicyKey ||
            (policies.find((p) => governs(p.policy, "personal/age"))?.key ?? "")
          }
          onChoosePolicy={setServicePolicyKey}
        />
      )}

      {tab === "requests" && (
        <RequestsTab
          serviceRequests={serviceRequests}
          verificationRequests={verificationRequests}
          onApprove={handleApprove}
          onDeny={handleDeny}
          loading={loading}
          canApprove={agentVault === "unlocked"}
        />
      )}

      {tab === "context" && (
        <ContextTab
          context={context}
          onUpdate={saveContext}
          storeStatus={contextStoreStatus}
          policies={policies}
          canAsk={agentVault === "unlocked"}
        />
      )}

      {tab === "identity" && (
        <IdentityTab
          rootIdentity={rootIdentity}
          currentEphemeralDID={currentEphemeralDID ?? authorizations[0]?.ephemeralDid ?? null}
          authorizations={authorizations}
          onExport={handleExportAuthorizations}
        />
      )}

      {tab === "policies" && <PoliciesTab policies={policies} />}

      {/* Service Status Bar */}
      <div className="status-bar">
        <div className="status-item">
          <span className={`status-dot ${contextStoreStatus === "connected" ? "green" : contextStoreStatus === "error" ? "red" : "yellow"}`} />
          Context Store
        </div>
        <div className="status-item" title={AGENT_VAULT_HINT[agentVault]}>
          <span className={`status-dot ${AGENT_VAULT_DOT[agentVault]}`} />
          Agent Vault
          {isUnlocked && agentVault !== "unlocked" && unlockPassword && (
            <button
              className="btn-link"
              style={{ marginLeft: "0.5rem" }}
              onClick={() => void unlockAgent(unlockPassword).then(setAgentVault)}
            >
              Unlock
            </button>
          )}
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
              Cardano {services.cardano.latest_block != null && `#${services.cardano.latest_block}`}
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
  policies,
  policyKey,
  onChoosePolicy,
}: {
  services: typeof DEMO_SERVICES;
  onRequest: (service: typeof DEMO_SERVICES[0]) => void;
  loading: boolean;
  /** The holder's policies; the request is made under the chosen one. */
  policies: StoredPolicy[];
  policyKey: string;
  onChoosePolicy: (key: string) => void;
}) {
  return (
    <div>
      <h2>Request a Service</h2>
      {policies.length > 0 && (
        <div className="form-group" style={{ marginBottom: "1rem" }}>
          <label>Under policy</label>
          <select value={policyKey} onChange={(e) => onChoosePolicy(e.target.value)}>
            {policies.map((p) => (
              <option key={p.key} value={p.key}>
                {p.policy.name} ({p.policy.rules.map((r) => r.context_scope).join(", ")})
              </option>
            ))}
          </select>
          <p style={{ marginTop: "0.25rem", fontSize: "0.75rem", color: "#64748b" }}>
            The business sees this policy's terms, never its id.
          </p>
        </div>
      )}
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
  canApprove,
}: {
  serviceRequests: ServiceRequest[];
  verificationRequests: VerificationRequest[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  loading: boolean;
  /** The agent holds the vault password, so an approval can read the data it proves. */
  canApprove: boolean;
}) {
  const pendingVerifications = verificationRequests.filter(
    (r) => r.status === "pending" || r.status === "escalated"
  );
  const resolvedVerifications = verificationRequests
    .filter((r) => r.status !== "pending" && r.status !== "escalated")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const activeServices = serviceRequests.filter((r) =>
    r.status === "pending" || r.status === "verification_required" || r.status === "verified"
  );
  const completedServices = serviceRequests
    .filter((r) => r.status === "completed" || r.status === "denied" || r.status === "rejected")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

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
                <strong>{request.business_name}</strong>
                <span className="badge badge-pending">Action Required</span>
              </div>
              <div className="request-details">
                <p>
                  <strong>Request:</strong>{" "}
                  {request.claim.type === "age"
                    ? `Verify you are at least ${String(request.claim.params.minAge)} years old`
                    : `Verify your ${request.claim.type}`}
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
                  <p>
                    ✓ Cost to you: nothing. {request.business_name} pays any proof fee.
                  </p>
                </div>
              </div>
              <div className="button-group" style={{ marginTop: "1rem" }}>
                <button
                  className="btn-success"
                  onClick={() => onApprove(request.id)}
                  disabled={loading || !canApprove}
                  title={canApprove ? undefined : "Unlock the agent's vault first (see the status bar)"}
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

      {/* Resolved verification requests */}
      {resolvedVerifications.length > 0 && (
        <>
          <h2 style={{ marginTop: pendingVerifications.length > 0 ? "2rem" : 0 }}>
            Verification History
          </h2>
          {resolvedVerifications.map((request) => (
            <div key={request.id} className="card">
              <div className="card-header">
                <strong>{request.business_name}</strong>
                <span
                  className={`badge ${
                    request.status === "approved" ? "badge-approved" : "badge-denied"
                  }`}
                >
                  {request.status}
                </span>
              </div>
              <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
                {request.claim.type === "age"
                  ? `Age check (${String(request.claim.params.minAge)}+)`
                  : request.claim.type}
              </p>
              {request.response?.reason && (
                <p style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
                  {request.response.reason}
                </p>
              )}
              {request.response?.proof && request.response.requester_did !== undefined && (
                <p style={{ marginTop: "0.25rem", fontSize: "0.875rem", color: "#64748b" }}>
                  {request.response.requester_did
                    ? `Proof is for your ephemeral DID ${truncateDID(request.response.requester_did)}, which signed this approval`
                    : "Proof is for no DID"}
                </p>
              )}
              {/* An on-chain proof cost DUST, which the business sponsors to the
                  proof service (ADR-007's business-pays model); the user never
                  pays, whether or not the proof reports how much it cost. An
                  offline proof made no transaction and cost nobody. */}
              {request.response?.proof?.verificationMethod === "on-chain" && (
                <p style={{ marginTop: "0.25rem", fontSize: "0.875rem", color: "#64748b" }}>
                  No cost to you: {request.business_name} paid the proof's network fee.
                </p>
              )}
              {request.response?.proof?.verificationMethod === "offline" && (
                <p style={{ marginTop: "0.25rem", fontSize: "0.875rem", color: "#64748b" }}>
                  No cost to you: this proof was generated offline and made no transaction.
                </p>
              )}
            </div>
          ))}
        </>
      )}


      {/* Active service requests */}
        <h2 style={{ marginTop: "2rem" }}>
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
                <strong>{request.service_name}</strong>
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
                  <strong>{request.service_name}</strong>
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
  policies,
  canAsk,
}: {
  context: PersonalContext;
  onUpdate: (ctx: PersonalContext) => void;
  storeStatus: "unknown" | "connected" | "error";
  policies: StoredPolicy[];
  /** The agent holds the vault password, so it can read what an ask is about. */
  canAsk: boolean;
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

      <AskBox policies={policies} canAsk={canAsk} />
    </div>
  );
}

function IdentityTab({
  rootIdentity,
  currentEphemeralDID,
  authorizations,
  onExport,
}: {
  rootIdentity: RootIdentity | null;
  currentEphemeralDID: string | null;
  authorizations: SerializedAuthorizationRecord[];
  onExport: () => void;
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
            <li>A record signed by your root DID stays in your vault, so you can later prove the DID was yours</li>
          </ul>
        </div>
      </div>

      {/* Authorization records: the user's own evidence, never shared */}
      <div className="card">
        <div className="card-header">
          <strong>Authorization Records</strong>
          <span className="badge badge-approved">{authorizations.length} kept</span>
        </div>
        <p style={{ fontSize: "0.875rem", color: "#64748b", marginTop: "0.5rem" }}>
          Each ephemeral DID comes with a record your root DID signed. The records
          stay encrypted in your vault and are never sent to a business. Export
          them when you need to prove a verification was yours (legal discovery,
          a dispute, an audit); the file verifies with the identity library.
          The export is not encrypted and links every ephemeral DID to your root
          DID, so treat the file as your identity.
        </p>
        {authorizations.length === 0 ? (
          <p style={{ color: "#64748b", marginTop: "1rem" }}>
            No records yet. One is kept each time you approve a verification.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
            {authorizations.map((record) => (
              <li
                key={record.ephemeralDid}
                style={{
                  padding: "0.75rem 0",
                  borderTop: "1px solid #e2e8f0",
                  fontSize: "0.875rem",
                }}
              >
                <div style={{ fontFamily: "monospace" }} title={record.ephemeralDid}>
                  {truncateDID(record.ephemeralDid)}
                </div>
                <div>{record.purpose}</div>
                <div style={{ color: "#64748b" }}>
                  Issued {new Date(record.timestamp).toLocaleString()}
                  {typeof record.context?.metadata?.requestExpiresAt === "string" &&
                    ` · for a request open until ${new Date(record.context.metadata.requestExpiresAt).toLocaleString()}`}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="button-group" style={{ marginTop: "1rem" }}>
          <button
            className="btn-secondary"
            onClick={onExport}
            disabled={!rootIdentity || authorizations.length === 0}
            title={authorizations.length === 0 ? "Nothing to export yet" : undefined}
          >
            Export for audit
          </button>
        </div>
      </div>

      {/* Future: an anchored root DID */}
      <div className="card" style={{ borderLeft: "4px solid #3b82f6" }}>
        <div className="card-header">
          <strong>Future: Anchored Identity</strong>
        </div>
        <p style={{ fontSize: "0.875rem", color: "#64748b", marginTop: "0.5rem" }}>
          Currently using <code>did:key</code> (W3C standard), or an atproto
          account bound to a local key. The planned anchor is{" "}
          <code>did:midnight</code> via Midnight Passport, with{" "}
          <code>did:prism</code> as the alternative.
        </p>
      </div>
    </div>
  );
}

/** The custody levels in plain words: whose machine may work on the data. */
const CUSTODY_WORDING: Record<Operator, string> = {
  device_only: "your own device only",
  owned_hardware: "hardware you control",
  community_node: "a node run by someone you know",
  federated_operator: "a federated operator, accountable through community governance",
  attested_enclave: "a verified secure enclave",
  any: "anyone",
};

function PoliciesTab({ policies }: { policies: StoredPolicy[] }) {
  return (
    <div>
      <h2>My S-PAL Policies</h2>
      <p className="subtitle">
        Kept encrypted in your vault; the agent reads them for every decision. A
        business sees a policy's terms and the hash below, never its id or owner.
      </p>

      {policies.length === 0 && (
        <div className="card">
          <p style={{ color: "#64748b" }}>No policies in the vault yet. Unlock it to seed the demo policy.</p>
        </div>
      )}

      {policies.map(({ key, policy, termsHash }) => (
        <div key={key} className="card">
          <div className="card-header">
            <strong>{policy.name}</strong>
            <span className="badge badge-approved">Active</span>
          </div>
          {policy.description && <p>{policy.description}</p>}

          {policy.rules.map((rule) => (
            <div
              key={rule.id}
              style={{ marginTop: "1rem", padding: "1rem", background: "#f8fafc", borderRadius: "8px" }}
            >
              <strong>Scope:</strong>
              <code style={{ marginLeft: "0.5rem", background: "#e0f2fe", padding: "2px 8px", borderRadius: "4px" }}>
                {rule.context_scope}
              </code>
              <ul style={{ marginTop: "0.5rem", paddingLeft: "1.5rem" }}>
                {rule.conditions.identity && (
                  <li>Identity: {rule.conditions.identity.type ?? "any"}</li>
                )}
                {rule.conditions.proofs?.map((proof) => (
                  <li key={`${proof.type}-${proof.claim}`}>
                    Proof required: {proof.type} of {proof.claim}
                  </li>
                ))}
                {rule.conditions.retention && (
                  <li>
                    Retention:{" "}
                    {rule.conditions.retention.max_seconds === 0
                      ? "none"
                      : `${rule.conditions.retention.max_seconds}s max`}
                  </li>
                )}
                {rule.conditions.derivatives && (
                  <li>
                    Derivative use: training {rule.conditions.derivatives.training ?? "forbidden"},
                    aggregation {rule.conditions.derivatives.aggregation ?? "forbidden"}, resale{" "}
                    {rule.conditions.derivatives.resale ?? "forbidden"}
                  </li>
                )}
                {rule.conditions.payment && (
                  <li>
                    Payment: {rule.conditions.payment.amount} {rule.conditions.payment.currency}
                  </li>
                )}
                <li>
                  Custody:{" "}
                  {rule.conditions.custody
                    ? (CUSTODY_WORDING[rule.conditions.custody.operator] ??
                      rule.conditions.custody.operator)
                    : "hardware you control (the default when a rule says nothing)"}
                  {rule.conditions.custody?.hosted_models === "allowed"
                    ? "; hosted models allowed (recorded, not yet enforced)"
                    : "; no hosted models (recorded, not yet enforced)"}
                  {rule.conditions.custody?.attestation_required ? "; attestation required" : ""}
                </li>
              </ul>
            </div>
          ))}

          <p style={{ marginTop: "1rem", fontSize: "0.75rem", color: "#64748b" }}>
            Terms hash (what a business accepts): <code>{termsHash}</code>
          </p>
          <p style={{ fontSize: "0.75rem", color: "#64748b" }}>Vault key: <code>{key}</code></p>
        </div>
      ))}
    </div>
  );
}

export default App;
