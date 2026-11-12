package terms

import (
	"crypto/sha256"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"maps"
	"slices"
	"strings"

	"github.com/freehold-earth/freehold/internal/spal"
)

// The members terms and their rules have, apart from the conditions themselves.
const (
	// conditionsMember is the member of a rule that holds its conditions.
	conditionsMember = "conditions"

	// enforcementMember is the member of the terms that says who enforces them on chain, which asks nothing of an
	// operator.
	enforcementMember = "enforcement"

	// rulesMember is the member of the terms that holds their rules.
	rulesMember = "rules"

	// scopeMember is the member of a rule that names the scope it governs.
	scopeMember = "context_scope"

	// versionMember is the member of the terms that says which S-PAL they are written in.
	versionMember = "version"
)

// scopeSeparator divides the parts of a scope: "notes/2026" is under "notes".
const scopeSeparator = "/"

var (
	// errIncomplete marks a condition that reads as JSON and still is not one S-PAL allows.
	errIncomplete = errors.New("not a condition S-PAL allows")

	// unbinding are the conditions that bind a business asking for a person's data and ask nothing of an operator
	// serving that person's own call. They are known, and not read.
	unbinding = []string{"identity", "payment", "proofs"}

	// versions are the S-PAL versions whose terms this package understands.
	versions = []string{"1.0", "1.1"}
)

// Terms is a person's terms, as an operator holds them: their hash, and their rules in the form the checks need.
//
// A Terms comes from Parse and does not change.
type Terms struct {
	// hash is the SHA-256 of the canonical JSON of the terms as they were given.
	hash [sha256.Size]byte

	// notUnderstood names the first thing in the terms that this package does not understand, or is empty.
	notUnderstood string

	// rules are the terms' rules, in the terms' own order. They are empty when notUnderstood is set.
	rules []rule
}

// custody is a rule's custody condition.
type custody struct {
	// AttestationRequired is whether the operator must prove what it runs.
	AttestationRequired bool `json:"attestation_required"`

	// HostedModels is whether a hosted model service may be given the data. It asks nothing of an operator here; it is
	// read so that a value outside its set is noticed.
	HostedModels spal.HostedModels `json:"hosted_models"`

	// Operator is the furthest custody level the data may reach.
	Operator spal.Custody `json:"operator"`
}

// derivatives is a rule's derivatives condition. A member the rule leaves out is empty.
type derivatives struct {
	// Aggregation is what the rule allows by way of aggregation.
	Aggregation spal.Aggregation `json:"aggregation"`

	// Resale is what the rule allows by way of resale.
	Resale spal.Resale `json:"resale"`

	// Training is what the rule allows by way of training.
	Training spal.Training `json:"training"`
}

// document is a person's terms taken apart as far as their shape goes: what they must have, each rule's conditions
// still as written, and what else they carry.
type document struct {
	// rules are the rules, in the terms' own order.
	rules []ruleDocument

	// unknown names the first member, of the terms or of a rule, that terms are not known to have, or is empty.
	unknown string

	// version is the S-PAL version the rules are written in.
	version string
}

// retention is a rule's retention condition.
type retention struct {
	// AuditLog is whether an audit log of access is kept, which asks nothing of an operator.
	AuditLog bool `json:"audit_log"`

	// MaxSeconds is the longest the data may be kept, where the rule says.
	MaxSeconds *uint64 `json:"max_seconds"`
}

// rule is one rule of a person's terms, with the conditions that bind an operator.
type rule struct {
	// custody is whose machine may hold the data, where the rule says.
	custody *custody

	// derivatives is what may be derived from the data, where the rule says.
	derivatives *derivatives

	// retention is how long the data may be kept, where the rule says.
	retention *retention

	// scope is the scope the rule governs.
	scope string
}

// ruleDocument is one rule taken apart as far as its shape goes.
type ruleDocument struct {
	// conditions are what the rule asks, by name, each still as it was written.
	conditions map[string]jsontext.Value

	// scope is the scope the rule governs.
	scope string
}

// Check decides whether an operator that commits to offered may serve a request about the data at scope.
//
// It returns nil if it may. Otherwise it returns a Refusal: ReasonConditionNotUnderstood if the terms ask for
// something this package does not understand, ReasonScopeNotGoverned if none of their rules governs scope, or
// ReasonCannotHonour, naming the condition, if offered does not keep what the governing rule asks.
func (t *Terms) Check(scope string, offered spal.Conditions) error {
	if t.notUnderstood != "" {
		return &Refusal{Reason: ReasonConditionNotUnderstood, Condition: t.notUnderstood}
	}

	governing, ok := t.governing(scope)
	if !ok {
		return &Refusal{Reason: ReasonScopeNotGoverned}
	}

	if condition := governing.unmetBy(offered); condition != "" {
		return &Refusal{Reason: ReasonCannotHonour, Condition: condition}
	}

	return nil
}

// Hash returns the terms hash: the SHA-256 of the canonical JSON of the terms as they were given to Parse.
func (t *Terms) Hash() [sha256.Size]byte {
	return t.hash
}

// Parse reads a person's terms from the JSON object data.
//
// It returns a Refusal with ReasonTermsMalformed if data is not terms at all: not one JSON object, or without a
// version, rules, or a scope and conditions on each rule. Terms that are well formed but ask for something this
// package does not understand are still read, because their hash is still theirs; Check refuses them.
func Parse(data []byte) (*Terms, error) {
	// The hash is over the object exactly as given, every member included, in its canonical form (RFC 8785).
	canonical := jsontext.Value(data).Clone()
	if err := canonical.Canonicalize(); err != nil || canonical.Kind() != '{' {
		return nil, &Refusal{Reason: ReasonTermsMalformed}
	}

	doc, ok := shape(canonical)
	if !ok {
		return nil, &Refusal{Reason: ReasonTermsMalformed}
	}

	terms := &Terms{hash: sha256.Sum256(canonical)}
	terms.rules, terms.notUnderstood = doc.understand()

	return terms, nil
}

// governing returns the rule that governs scope: the first rule for scope itself, or failing that the first rule for
// the nearest scope above it.
func (t *Terms) governing(scope string) (rule, bool) {
	for {
		i := slices.IndexFunc(t.rules, func(r rule) bool { return r.scope == scope })
		if i >= 0 {
			return t.rules[i], true
		}

		cut := strings.LastIndex(scope, scopeSeparator)
		if cut < 0 {
			return rule{}, false
		}
		scope = scope[:cut]
	}
}

// member returns the member of object called name, if it is there and is JSON of the given kind.
func member(object map[string]jsontext.Value, name string, kind jsontext.Kind) (jsontext.Value, bool) {
	value, ok := object[name]
	if !ok || value.Kind() != kind {
		return nil, false
	}

	return value, true
}

// members returns the members of the JSON object value by name, and false if value is not a JSON object.
func members(value jsontext.Value) (map[string]jsontext.Value, bool) {
	if value.Kind() != '{' {
		return nil, false
	}

	var object map[string]jsontext.Value
	if err := json.Unmarshal(value, &object); err != nil {
		return nil, false
	}

	return object, true
}

// other returns the first name in object, in name order, that is not one of known, or the empty string.
func other(object map[string]jsontext.Value, known ...string) string {
	for _, name := range slices.Sorted(maps.Keys(object)) {
		if !slices.Contains(known, name) {
			return name
		}
	}

	return ""
}

// read returns value as a condition of type T, which must be a JSON object with no member T does not have.
func read[T any](value jsontext.Value) (*T, error) {
	if value.Kind() != '{' {
		return nil, errIncomplete
	}

	var condition T
	if err := json.Unmarshal(value, &condition, json.RejectUnknownMembers(true)); err != nil {
		return nil, err
	}

	return &condition, nil
}

// shape takes terms apart as far as their shape goes, and returns false if they do not have the shape of terms: a
// JSON object with a version that is text and rules that are a list, each rule an object with a scope that is
// non-empty text and conditions that are an object.
func shape(canonical jsontext.Value) (document, bool) {
	top, ok := members(canonical)
	if !ok {
		return document{}, false
	}
	doc := document{unknown: other(top, enforcementMember, rulesMember, versionMember)}

	version, ok := member(top, versionMember, '"')
	if !ok || json.Unmarshal(version, &doc.version) != nil {
		return document{}, false
	}

	list, ok := member(top, rulesMember, '[')
	var written []jsontext.Value
	if !ok || json.Unmarshal(list, &written) != nil {
		return document{}, false
	}

	for _, value := range written {
		object, ok := members(value)
		if !ok {
			return document{}, false
		}
		if doc.unknown == "" {
			doc.unknown = other(object, conditionsMember, scopeMember)
		}

		var r ruleDocument
		scope, ok := member(object, scopeMember, '"')
		if !ok || json.Unmarshal(scope, &r.scope) != nil || r.scope == "" {
			return document{}, false
		}
		conditions, ok := member(object, conditionsMember, '{')
		if !ok {
			return document{}, false
		}
		if r.conditions, ok = members(conditions); !ok {
			return document{}, false
		}

		doc.rules = append(doc.rules, r)
	}

	return doc, true
}

// understand returns the terms' rules in the form the checks need, or names the first thing in the terms that this
// package does not understand: a version or a member it does not know, or a condition that is not one of S-PAL's or
// holds a value S-PAL does not allow. Members are taken in name order, so the same terms always name the same thing.
func (d document) understand() ([]rule, string) {
	if !slices.Contains(versions, d.version) {
		return nil, versionMember
	}
	if d.unknown != "" {
		return nil, d.unknown
	}

	rules := make([]rule, 0, len(d.rules))
	for _, written := range d.rules {
		r := rule{scope: written.scope}
		for _, name := range slices.Sorted(maps.Keys(written.conditions)) {
			value := written.conditions[name]

			var err error
			switch {
			case name == conditionCustody:
				r.custody, err = read[custody](value)
				if err == nil && r.custody.Operator == "" {
					err = errIncomplete
				}
			case name == conditionDerivatives:
				r.derivatives, err = read[derivatives](value)
			case name == conditionRetention:
				r.retention, err = read[retention](value)
				if err == nil && r.retention.MaxSeconds != nil && *r.retention.MaxSeconds > spal.MaxSafeInteger {
					err = errIncomplete
				}
			case slices.Contains(unbinding, name):
			default:
				err = errIncomplete
			}
			if err != nil {
				return nil, name
			}
		}
		rules = append(rules, r)
	}

	return rules, ""
}

// unmetBy names the first condition of the rule that an operator committing to offered does not keep, or returns the
// empty string if it keeps them all.
func (r rule) unmetBy(offered spal.Conditions) string {
	// A rule that says nothing about custody keeps the data on hardware its holder owns.
	ceiling := spal.CustodyOwnedHardware
	attestation := false
	if r.custody != nil {
		ceiling = r.custody.Operator
		attestation = r.custody.AttestationRequired
	}
	if !offered.Custody.Within(ceiling) {
		return conditionCustody
	}
	// No way for an operator to prove what it runs is defined yet, so none can meet a rule that asks for it.
	if attestation {
		return conditionAttestation
	}

	if kept := r.retention; kept != nil && kept.MaxSeconds != nil &&
		offered.RetentionSeconds > *kept.MaxSeconds {
		return conditionRetention
	}

	// A derivative the rule states is kept by committing to the same value, or to forbidding it outright.
	if derived := r.derivatives; derived != nil {
		if derived.Training != "" && offered.Training != derived.Training &&
			offered.Training != spal.TrainingForbidden {
			return conditionTraining
		}
		if derived.Aggregation != "" && offered.Aggregation != derived.Aggregation &&
			offered.Aggregation != spal.AggregationForbidden {
			return conditionAggregation
		}
		if derived.Resale != "" && offered.Resale != derived.Resale && offered.Resale != spal.ResaleForbidden {
			return conditionResale
		}
	}

	return ""
}
