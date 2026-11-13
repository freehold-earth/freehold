package terms

import (
	"crypto/sha256"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
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

// versions are the S-PAL versions whose terms this package understands.
var versions = []string{"1.0", "1.1"}

// Terms is a person's terms, as an operator holds them: their hash, and their rules in the form the checks need.
//
// A Terms comes from Parse and does not change.
type Terms struct {
	// hash is the SHA-256 of the canonical JSON of the terms as they were given.
	hash [sha256.Size]byte

	// notUnderstood is the refusal for the first thing in the terms that this package does not understand, or nil.
	notUnderstood *Refusal

	// rules are the terms' rules, in the terms' own order. They are empty when notUnderstood is set.
	rules []rule
}

// custody is a rule's custody condition.
type custody struct {
	// AttestationRequired is whether the operator must prove what it runs.
	AttestationRequired bool `json:"attestation_required"`

	// HostedModels is whether a hosted model service may be given the data.
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

// Commitment returns what an operator with the given tolerance commits to for a request about the data at scope:
// its own custody level, and for everything else what the governing rule permits. Where the rule says nothing of
// retention or of a derivative, the commitment is the strictest there is: nothing kept, the derivative forbidden.
// The tolerance never adds to what the rule permits.
//
// It returns a Refusal if the operator may not serve the request: ReasonConditionNotUnderstood if the terms ask for
// something this package does not understand, ReasonScopeNotGoverned if none of their rules governs scope, or
// ReasonCannotHonor, naming the condition, if the governing rule is stricter than tolerance. A tolerance that is
// not valid is an error that is not a Refusal, since nothing is wrong with the request.
func (t *Terms) Commitment(scope string, tolerance spal.Tolerance) (spal.Conditions, error) {
	if err := tolerance.Validate(); err != nil {
		return spal.Conditions{}, fmt.Errorf("tolerance: %w", err)
	}

	if t.notUnderstood != nil {
		return spal.Conditions{}, t.notUnderstood
	}

	governing, ok := t.governing(scope)
	if !ok {
		return spal.Conditions{}, &Refusal{Reason: ReasonScopeNotGoverned}
	}

	commitment, refusal := governing.commitment(tolerance)
	if refusal != nil {
		return spal.Conditions{}, refusal
	}

	return commitment, nil
}

// Hash returns the terms hash: the SHA-256 of the canonical JSON of the terms as they were given to Parse.
func (t *Terms) Hash() [sha256.Size]byte {
	return t.hash
}

// Parse reads a person's terms from the JSON object data.
//
// It returns a Refusal with ReasonTermsMalformed if data is not terms at all: not one JSON object, or without a
// version, rules, or a scope and conditions on each rule. Terms that are well formed but ask for something this
// package does not understand are still read, because their hash is still theirs; Commitment refuses them.
func Parse(data []byte) (*Terms, error) {
	// The hash is over the object exactly as given, every member included, in its canonical form (RFC 8785).
	canonical := jsontext.Value(data).Clone()
	if err := canonical.Canonicalize(); err != nil {
		return nil, &Refusal{Reason: ReasonTermsMalformed, cause: err}
	}

	doc, err := shape(canonical)
	if err != nil {
		return nil, &Refusal{Reason: ReasonTermsMalformed, cause: err}
	}

	terms := &Terms{hash: sha256.Sum256(canonical)}
	terms.rules, terms.notUnderstood = doc.understand()

	return terms, nil
}

// commitment returns what the rule permits an operator at tolerance's custody level, or the refusal naming the
// first condition on which the rule is stricter than tolerance.
func (r rule) commitment(tolerance spal.Tolerance) (spal.Conditions, *Refusal) {
	// A rule that says nothing about custody keeps the data on hardware its holder owns.
	ceiling := spal.CustodyOwnedHardware
	attestation := false
	if r.custody != nil {
		ceiling = r.custody.Operator
		attestation = r.custody.AttestationRequired
	}
	if !tolerance.Custody.Within(ceiling) {
		return spal.Conditions{}, &Refusal{Reason: ReasonCannotHonor, Condition: conditionCustody}
	}
	// No way for an operator to prove what it runs is defined yet, so none can meet a rule that asks for it.
	if attestation {
		return spal.Conditions{}, &Refusal{Reason: ReasonCannotHonor, Condition: conditionAttestation}
	}

	permitted := r.permits(tolerance.Custody)
	switch {
	case permitted.RetentionSeconds < tolerance.RetentionMinSeconds:
		return spal.Conditions{}, &Refusal{Reason: ReasonCannotHonor, Condition: conditionRetention}
	case !tolerance.Training.Within(permitted.Training):
		return spal.Conditions{}, &Refusal{Reason: ReasonCannotHonor, Condition: conditionTraining}
	case !tolerance.Aggregation.Within(permitted.Aggregation):
		return spal.Conditions{}, &Refusal{Reason: ReasonCannotHonor, Condition: conditionAggregation}
	case !tolerance.Resale.Within(permitted.Resale):
		return spal.Conditions{}, &Refusal{Reason: ReasonCannotHonor, Condition: conditionResale}
	}

	return permitted, nil
}

// governing returns the rule that governs scope: the first rule for scope itself, or failing that the first rule for
// the nearest scope above it.
func (t *Terms) governing(scope string) (rule, bool) {
	for {
		i := slices.IndexFunc(t.rules, func(r rule) bool { return r.scope == scope })
		if i >= 0 {
			return t.rules[i], true
		}

		above, _, found := strings.CutLast(scope, scopeSeparator)
		if !found {
			return rule{}, false
		}
		scope = above
	}
}

// member returns the member of object called name, which must be there and be JSON of the given kind.
func member(object map[string]jsontext.Value, name string, kind jsontext.Kind) (jsontext.Value, error) {
	value, ok := object[name]
	if !ok {
		return nil, fmt.Errorf("%s is missing", name)
	}
	if value.Kind() != kind {
		return nil, fmt.Errorf("%s is JSON of the wrong kind", name)
	}

	return value, nil
}

// members returns the members of the JSON object value by name.
func members(value jsontext.Value) (map[string]jsontext.Value, error) {
	if value.Kind() != '{' {
		return nil, errors.New("not a JSON object")
	}

	var object map[string]jsontext.Value
	if err := json.Unmarshal(value, &object); err != nil {
		return nil, err
	}

	return object, nil
}

// notUnderstood returns the refusal for terms that ask for something this package does not understand, naming it.
func notUnderstood(name string, cause error) *Refusal {
	return &Refusal{Reason: ReasonConditionNotUnderstood, Condition: name, cause: cause}
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

// permits returns what the rule permits an operator that runs at the given custody level. What the rule does not
// state it does not permit: nothing is kept, and every derivative is forbidden.
func (r rule) permits(level spal.Custody) spal.Conditions {
	permitted := spal.Conditions{
		Custody:     level,
		Training:    spal.TrainingForbidden,
		Aggregation: spal.AggregationForbidden,
		Resale:      spal.ResaleForbidden,
	}
	if kept := r.retention; kept != nil && kept.MaxSeconds != nil {
		permitted.RetentionSeconds = *kept.MaxSeconds
	}
	if derived := r.derivatives; derived != nil {
		if derived.Training != "" {
			permitted.Training = derived.Training
		}
		if derived.Aggregation != "" {
			permitted.Aggregation = derived.Aggregation
		}
		if derived.Resale != "" {
			permitted.Resale = derived.Resale
		}
	}

	return permitted
}

// read returns value as a condition of type T, which must be a JSON object with no member T does not have.
func read[T any](value jsontext.Value) (*T, error) {
	if value.Kind() != '{' {
		return nil, errors.New("not a JSON object")
	}

	var condition T
	if err := json.Unmarshal(value, &condition, json.RejectUnknownMembers(true)); err != nil {
		return nil, err
	}

	return &condition, nil
}

// shape takes terms apart as far as their shape goes. It returns an error if they do not have the shape of terms: a
// JSON object with a version that is text and rules that are a list, each rule an object with a scope that is
// non-empty text and conditions that are an object.
func shape(canonical jsontext.Value) (document, error) {
	top, err := members(canonical)
	if err != nil {
		return document{}, fmt.Errorf("terms: %w", err)
	}
	doc := document{unknown: other(top, enforcementMember, rulesMember, versionMember)}

	version, err := member(top, versionMember, '"')
	if err != nil {
		return document{}, err
	}
	if err := json.Unmarshal(version, &doc.version); err != nil {
		return document{}, fmt.Errorf("%s: %w", versionMember, err)
	}

	var written []jsontext.Value
	list, err := member(top, rulesMember, '[')
	if err != nil {
		return document{}, err
	}
	if err := json.Unmarshal(list, &written); err != nil {
		return document{}, fmt.Errorf("%s: %w", rulesMember, err)
	}

	for _, value := range written {
		object, err := members(value)
		if err != nil {
			return document{}, fmt.Errorf("a rule: %w", err)
		}
		if doc.unknown == "" {
			doc.unknown = other(object, conditionsMember, scopeMember)
		}

		var r ruleDocument
		scope, err := member(object, scopeMember, '"')
		if err != nil {
			return document{}, fmt.Errorf("a rule: %w", err)
		}
		if err := json.Unmarshal(scope, &r.scope); err != nil {
			return document{}, fmt.Errorf("a rule: %s: %w", scopeMember, err)
		}
		if r.scope == "" {
			return document{}, fmt.Errorf("a rule: %s is empty", scopeMember)
		}

		conditions, err := member(object, conditionsMember, '{')
		if err != nil {
			return document{}, fmt.Errorf("the rule for %s: %w", r.scope, err)
		}
		if r.conditions, err = members(conditions); err != nil {
			return document{}, fmt.Errorf("the rule for %s: %s: %w", r.scope, conditionsMember, err)
		}

		doc.rules = append(doc.rules, r)
	}

	return doc, nil
}

// understand returns the terms' rules in the form the checks need, or the refusal for the first thing in the terms
// that this package does not understand: a version or a member it does not know, or a condition of a rule. The same
// terms are always refused for the same thing.
func (d document) understand() ([]rule, *Refusal) {
	if !slices.Contains(versions, d.version) {
		return nil, notUnderstood(versionMember, errors.New("not an S-PAL version this operator reads"))
	}
	if d.unknown != "" {
		return nil, notUnderstood(d.unknown, errors.New("not a member terms have"))
	}

	rules := make([]rule, 0, len(d.rules))
	for _, written := range d.rules {
		r, refusal := written.understand()
		if refusal != nil {
			return nil, refusal
		}
		rules = append(rules, r)
	}

	return rules, nil
}

// understand returns the rule in the form the checks need, or the refusal for the first of its conditions, in name
// order, that is not one of S-PAL's or holds a value S-PAL does not allow.
func (d ruleDocument) understand() (rule, *Refusal) {
	r := rule{scope: d.scope}
	for _, name := range slices.Sorted(maps.Keys(d.conditions)) {
		value := d.conditions[name]

		var err error
		switch name {
		case conditionCustody:
			r.custody, err = read[custody](value)
			if err == nil && r.custody.Operator == "" {
				err = errors.New("operator is missing")
			}
		case conditionDerivatives:
			r.derivatives, err = read[derivatives](value)
		case conditionRetention:
			r.retention, err = read[retention](value)
			if err == nil && r.retention.MaxSeconds != nil && *r.retention.MaxSeconds > spal.MaxSafeInteger {
				err = fmt.Errorf("max_seconds is above %d", uint64(spal.MaxSafeInteger))
			}
		case conditionIdentity, conditionPayment, conditionProofs:
			// Known, and not read: these bind a business asking for the data, and ask nothing of an operator.
		default:
			err = errors.New("not a condition S-PAL has")
		}
		if err != nil {
			return rule{}, notUnderstood(name, fmt.Errorf("the rule for %s: %w", d.scope, err))
		}
	}

	return r, nil
}
