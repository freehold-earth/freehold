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

// The member names of terms and of a rule.
const (
	// conditionsMember is the name of a rule's conditions.
	conditionsMember = "conditions"

	// enforcementMember is the name of the on-chain enforcement settings, which place no requirement on an operator.
	enforcementMember = "enforcement"

	// rulesMember is the name of the list of rules.
	rulesMember = "rules"

	// scopeMember is the name of the scope a rule governs.
	scopeMember = "context_scope"

	// versionMember is the name of the S-PAL version.
	versionMember = "version"
)

// scopeSeparator separates the parts of a scope, so "notes/2026" is under "notes".
const scopeSeparator = "/"

// versions lists the S-PAL versions this package understands.
var versions = []string{"1.0", "1.1"}

// Limits is the most that one rule permits an operator.
// The zero value permits nothing.
type Limits struct {
	// most is the weakest conditions the rule accepts.
	most spal.Conditions
}

// Terms is an end-user's parsed terms.
// It is immutable.
type Terms struct {
	// hash is the SHA-256 of the canonical JSON of the terms.
	hash [sha256.Size]byte

	// notUnderstood is the refusal for the first part of the terms this package does not understand, or nil.
	notUnderstood *Refusal

	// rules holds the rules in the order of the terms.
	// It is empty when notUnderstood is set.
	rules []rule
}

// custody is the custody condition of a rule.
type custody struct {
	// AttestationRequired reports whether the operator must attest to what it runs.
	AttestationRequired bool `json:"attestation_required"`

	// HostedModels is the rule's setting for giving the data to a hosted model service.
	HostedModels spal.HostedModels `json:"hosted_models"`

	// Operator is the furthest custody level the data may reach.
	Operator spal.Custody `json:"operator"`
}

// derivatives is the derivatives condition of a rule.
// A member the rule omits is empty.
type derivatives struct {
	// Aggregation is the aggregation the rule permits.
	Aggregation spal.Aggregation `json:"aggregation"`

	// Resale is the resale the rule permits.
	Resale spal.Resale `json:"resale"`

	// Training is the training the rule permits.
	Training spal.Training `json:"training"`
}

// document is terms parsed only as far as their structure.
type document struct {
	// rules holds the rules in the order of the terms.
	rules []ruleDocument

	// unknown is the name of the first unrecognized member of the terms or of a rule, or empty.
	unknown string

	// version is the S-PAL version of the terms.
	version string
}

// retention is the retention condition of a rule.
type retention struct {
	// AuditLog reports whether an access log is kept, which places no requirement on an operator.
	AuditLog bool `json:"audit_log"`

	// MaxSeconds is the longest the data may be kept, or nil when the rule sets no limit.
	MaxSeconds *uint64 `json:"max_seconds"`
}

// rule is one rule of the terms, with the conditions that bind an operator.
type rule struct {
	// custody is the custody condition, or nil.
	custody *custody

	// derivatives is the derivatives condition, or nil.
	derivatives *derivatives

	// retention is the retention condition, or nil.
	retention *retention

	// scope is the scope the rule governs.
	scope string
}

// ruleDocument is one rule parsed only as far as its structure.
type ruleDocument struct {
	// conditions maps each condition name to its raw value.
	conditions map[string]jsontext.Value

	// scope is the scope the rule governs.
	scope string
}

// Allows returns nil when committed is within the limits, or an error that names the first condition beyond them.
// Custody and retention must not exceed the limit.
// A derivative must equal the limit or be forbidden.
func (l Limits) Allows(committed spal.Conditions) error {
	const derivative = "%s is %s, where the rule says %s"

	// Invalid values are rejected first, so the checks below compare and report only valid ones.
	if committed.Validate() != nil {
		return errors.New("a condition is not a value S-PAL allows for it")
	}

	most := l.most
	switch {
	case !committed.Custody.Within(most.Custody):
		// The zero value has no custody level to report.
		if most.Custody == "" {
			return errors.New("no rule permits anything")
		}
		return fmt.Errorf("%s is %s, beyond the rule's %s", conditionCustody, committed.Custody, most.Custody)
	case committed.RetentionSeconds > most.RetentionSeconds:
		return fmt.Errorf(
			"%s is %d seconds, above the rule's %d",
			conditionRetention,
			committed.RetentionSeconds,
			most.RetentionSeconds,
		)
	case committed.Training != most.Training && committed.Training != spal.TrainingForbidden:
		return fmt.Errorf(derivative, conditionTraining, committed.Training, most.Training)
	case committed.Aggregation != most.Aggregation && committed.Aggregation != spal.AggregationForbidden:
		return fmt.Errorf(derivative, conditionAggregation, committed.Aggregation, most.Aggregation)
	case committed.Resale != most.Resale && committed.Resale != spal.ResaleForbidden:
		return fmt.Errorf(derivative, conditionResale, committed.Resale, most.Resale)
	}

	return nil
}

// Commitment returns the conditions an operator with tolerance commits to for a request about the data at scope.
// The custody level is the operator's own, and every other condition is what the governing rule permits.
// A condition the rule omits takes its strictest value.
// It returns a *Refusal when the operator may not serve the request, and another error when tolerance is not valid.
func (t *Terms) Commitment(scope string, tolerance spal.Tolerance) (spal.Conditions, error) {
	if err := tolerance.Validate(); err != nil {
		return spal.Conditions{}, fmt.Errorf("tolerance: %w", err)
	}

	governing, refusal := t.governing(scope)
	if refusal != nil {
		return spal.Conditions{}, refusal
	}

	commitment, refusal := governing.commitment(tolerance)
	if refusal != nil {
		return spal.Conditions{}, refusal
	}

	return commitment, nil
}

// Hash returns the SHA-256 of the canonical JSON of the terms.
func (t *Terms) Hash() [sha256.Size]byte {
	return t.hash
}

// Limits returns the limits of the rule that governs scope.
// A condition the rule omits takes its strictest value.
// It returns a *Refusal when no operator may serve a request for scope under the terms.
func (t *Terms) Limits(scope string) (Limits, error) {
	governing, refusal := t.governing(scope)
	if refusal != nil {
		return Limits{}, refusal
	}
	// No attestation mechanism is defined, so no operator can meet a rule that requires one.
	if governing.attested() {
		return Limits{}, &Refusal{Condition: conditionAttestation, Reason: ReasonCannotHonor}
	}

	return Limits{most: governing.permits(governing.ceiling())}, nil
}

// Parse reads an end-user's terms from the JSON object data.
// It returns a *Refusal with ReasonTermsMalformed when data does not have the structure of terms.
// Well-formed terms that this package does not understand still parse, so that their hash is available.
func Parse(data []byte) (*Terms, error) {
	// The hash covers the object as given, in its canonical form (RFC 8785).
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

// attested reports whether the rule requires attestation.
func (r rule) attested() bool {
	return r.custody != nil && r.custody.AttestationRequired
}

// ceiling returns the furthest custody level the rule permits.
// A rule with no custody condition permits only hardware the end-user owns.
func (r rule) ceiling() spal.Custody {
	if r.custody == nil {
		return spal.CustodyOwnedHardware
	}

	return r.custody.Operator
}

// commitment returns the conditions the rule permits an operator at the custody level of tolerance.
// It returns a *Refusal that names the first condition on which the rule is stricter than tolerance.
func (r rule) commitment(tolerance spal.Tolerance) (spal.Conditions, *Refusal) {
	if !tolerance.Custody.Within(r.ceiling()) {
		return spal.Conditions{}, &Refusal{Condition: conditionCustody, Reason: ReasonCannotHonor}
	}
	// No attestation mechanism is defined, so no operator can meet a rule that requires one.
	if r.attested() {
		return spal.Conditions{}, &Refusal{Condition: conditionAttestation, Reason: ReasonCannotHonor}
	}

	permitted := r.permits(tolerance.Custody)
	switch {
	case permitted.RetentionSeconds < tolerance.RetentionMinSeconds:
		return spal.Conditions{}, &Refusal{Condition: conditionRetention, Reason: ReasonCannotHonor}
	case !tolerance.Training.Within(permitted.Training):
		return spal.Conditions{}, &Refusal{Condition: conditionTraining, Reason: ReasonCannotHonor}
	case !tolerance.Aggregation.Within(permitted.Aggregation):
		return spal.Conditions{}, &Refusal{Condition: conditionAggregation, Reason: ReasonCannotHonor}
	case !tolerance.Resale.Within(permitted.Resale):
		return spal.Conditions{}, &Refusal{Condition: conditionResale, Reason: ReasonCannotHonor}
	}

	return permitted, nil
}

// governing returns the rule that governs scope.
// That is the first rule for scope itself, or else the first rule for its nearest parent scope.
// It returns a *Refusal when the terms are not understood or no rule governs scope.
func (t *Terms) governing(scope string) (rule, *Refusal) {
	if t.notUnderstood != nil {
		return rule{}, t.notUnderstood
	}

	for {
		i := slices.IndexFunc(t.rules, func(r rule) bool { return r.scope == scope })
		if i >= 0 {
			return t.rules[i], nil
		}

		above, _, found := strings.CutLast(scope, scopeSeparator)
		if !found {
			return rule{}, &Refusal{Reason: ReasonScopeNotGoverned}
		}
		scope = above
	}
}

// member returns the member name of object, which must be present and of the given JSON kind.
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

// members returns the members of the JSON object value, keyed by name.
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

// notUnderstood returns the refusal for terms that contain name, which this package does not understand.
func notUnderstood(name string, cause error) *Refusal {
	return &Refusal{Condition: name, Reason: ReasonConditionNotUnderstood, cause: cause}
}

// other returns the first name in object, in sorted order, that is not in known, or the empty string.
func other(object map[string]jsontext.Value, known ...string) string {
	for _, name := range slices.Sorted(maps.Keys(object)) {
		if !slices.Contains(known, name) {
			return name
		}
	}

	return ""
}

// permits returns the conditions the rule permits an operator at the given custody level.
// A condition the rule omits takes its strictest value.
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

// read decodes value as a condition of type T, which must be a JSON object with only the members of T.
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

// shape parses the structure of terms.
// It returns an error when the terms lack a text version or a list of rules.
// It also returns an error when a rule lacks a non-empty scope or an object of conditions.
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

// understand returns the rules in parsed form.
// It returns the refusal for the first part of the terms that this package does not understand.
// NOTE: The same terms always produce the same refusal.
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

// understand returns the rule in parsed form.
// It returns the refusal for the first condition, in name order, that is unknown or holds an invalid value.
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
			// These conditions bind a business that requests the data, and place no requirement on an operator.
		default:
			err = errors.New("not a condition S-PAL has")
		}
		if err != nil {
			return rule{}, notUnderstood(name, fmt.Errorf("the rule for %s: %w", d.scope, err))
		}
	}

	return r, nil
}
