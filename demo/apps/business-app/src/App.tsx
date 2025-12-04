import { useState } from "react";
import type { VerificationResponse } from "./types";

type Tab = "verify" | "history";

interface VerificationRecord {
  id: string;
  customerId: string;
  type: "age" | "credential";
  claim: string;
  status: "pending" | "verified" | "rejected";
  response?: VerificationResponse;
  createdAt: Date;
}

// Demo data
const initialHistory: VerificationRecord[] = [];

function App() {
  const [tab, setTab] = useState<Tab>("verify");
  const [history, setHistory] = useState<VerificationRecord[]>(initialHistory);

  const handleVerificationSubmit = (record: VerificationRecord) => {
    setHistory((prev) => [record, ...prev]);

    // Simulate async response (in real app, this would poll for user approval)
    setTimeout(() => {
      setHistory((prev) =>
        prev.map((r) =>
          r.id === record.id
            ? {
                ...r,
                status: "verified",
                response: {
                  requestId: r.id,
                  status: "verified",
                  proof: {
                    proof: btoa(JSON.stringify({ mock: true })),
                    circuitId: "age_verification",
                    verificationKey: "vk_mock",
                    timestamp: new Date(),
                  },
                  publicSignals: {
                    verified: true,
                    minAge: 18,
                  },
                },
              }
            : r
        )
      );
    }, 3000);
  };

  return (
    <div className="container">
      <h1>PCI Business App</h1>
      <p className="subtitle">Request verified information from customers</p>

      <div className="tabs">
        <button
          className={`tab ${tab === "verify" ? "active" : ""}`}
          onClick={() => setTab("verify")}
        >
          New Verification
        </button>
        <button
          className={`tab ${tab === "history" ? "active" : ""}`}
          onClick={() => setTab("history")}
        >
          History {history.length > 0 && `(${history.length})`}
        </button>
      </div>

      {tab === "verify" && (
        <VerifyTab onSubmit={handleVerificationSubmit} />
      )}

      {tab === "history" && <HistoryTab history={history} />}
    </div>
  );
}

function VerifyTab({
  onSubmit,
}: {
  onSubmit: (record: VerificationRecord) => void;
}) {
  const [verificationType, setVerificationType] = useState<"age" | "credential">(
    "age"
  );
  const [minAge, setMinAge] = useState(18);
  const [customerId, setCustomerId] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const record: VerificationRecord = {
      id: `ver-${Date.now()}`,
      customerId: customerId || "demo-user",
      type: verificationType,
      claim:
        verificationType === "age"
          ? `Age >= ${minAge}`
          : "Valid credential",
      status: "pending",
      createdAt: new Date(),
    };

    onSubmit(record);
    alert(
      "Verification request sent! The customer will be asked to approve this request."
    );
  };

  return (
    <div>
      <h2>Request Customer Verification</h2>

      <div className="warning-box">
        <p>
          <strong>Privacy Notice:</strong> You will only receive a yes/no
          verification result. You will NOT receive the customer's actual
          personal data.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="card">
        <div className="form-group">
          <label>Customer ID (optional)</label>
          <input
            type="text"
            placeholder="Leave empty for demo"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>Verification Type</label>
          <select
            value={verificationType}
            onChange={(e) =>
              setVerificationType(e.target.value as "age" | "credential")
            }
          >
            <option value="age">Age Verification</option>
            <option value="credential">Credential Verification</option>
          </select>
        </div>

        {verificationType === "age" && (
          <div className="form-group">
            <label>Minimum Age Required</label>
            <input
              type="number"
              min={1}
              max={150}
              value={minAge}
              onChange={(e) => setMinAge(parseInt(e.target.value))}
            />
          </div>
        )}

        <div
          style={{
            background: "#f8fafc",
            padding: "1rem",
            borderRadius: "8px",
            marginBottom: "1rem",
          }}
        >
          <strong>What you're requesting:</strong>
          <p style={{ marginTop: "0.5rem" }}>
            {verificationType === "age"
              ? `"Is this customer at least ${minAge} years old?"`
              : `"Does this customer have a valid credential?"`}
          </p>
          <p
            style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#64748b" }}
          >
            You will receive: <code>{"{ verified: true/false }"}</code>
          </p>
        </div>

        <button type="submit" className="btn-primary">
          Send Verification Request
        </button>
      </form>
    </div>
  );
}

function HistoryTab({ history }: { history: VerificationRecord[] }) {
  if (history.length === 0) {
    return (
      <div className="card empty-state">
        <p>No verification requests yet</p>
        <p style={{ fontSize: "0.875rem", marginTop: "0.5rem" }}>
          Submit a verification request to see it here
        </p>
      </div>
    );
  }

  return (
    <div>
      <h2>Verification History</h2>

      {history.map((record) => (
        <div key={record.id} className="card">
          <div className="card-header">
            <strong>Customer: {record.customerId}</strong>
            <span
              className={`badge ${
                record.status === "verified"
                  ? "badge-verified"
                  : record.status === "rejected"
                  ? "badge-rejected"
                  : "badge-pending"
              }`}
            >
              {record.status}
            </span>
          </div>

          <p>
            <strong>Request:</strong> {record.claim}
          </p>
          <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
            {record.createdAt.toLocaleString()}
          </p>

          {record.status === "pending" && (
            <p style={{ marginTop: "1rem", color: "#a16207" }}>
              Waiting for customer approval...
            </p>
          )}

          {record.response && record.status === "verified" && (
            <div className="proof-display">
              <h4>Verification Result</h4>
              <pre>
                {JSON.stringify(record.response.publicSignals, null, 2)}
              </pre>
              <p
                style={{
                  marginTop: "0.5rem",
                  fontSize: "0.875rem",
                  color: "#166534",
                }}
              >
                Zero-knowledge proof verified. Customer's actual data was never
                revealed.
              </p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default App;
