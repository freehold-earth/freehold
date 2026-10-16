# Demo Scenarios

Pre-configured scenarios for demonstrating PCI capabilities.

## Available Scenarios

### Age Verification (`age-verification.json`)

**Use Case:** Bar/venue verifying customer is >= 18

**Flow:**
1. User has birth date in context store
2. Business requests "is customer >= 18?"
3. User approves request
4. ZK proof generated: `{ verified: true, minAge: 18 }`
5. Business never sees actual birth date

**Key Points:**
- Zero data retention
- No derivatives allowed
- No payment required

## Adding New Scenarios

Create a JSON file following the `DemoScenario` type:

```json
{
  "id": "unique-id",
  "name": "Scenario Name",
  "description": "What this demonstrates",
  "userContext": { ... },
  "policies": [ ... ],
  "sampleRequests": [ ... ]
}
```

## Future Scenarios

- **KYC Lite** - Verify identity without revealing documents
- **Employment Proof** - Prove employment without salary disclosure
- **Health Credential** - Prove vaccination without revealing health records
- **Credit Check** - Prove creditworthiness without revealing finances
