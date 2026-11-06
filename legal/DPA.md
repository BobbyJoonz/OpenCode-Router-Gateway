# Data Processing Agreement (template)

Between **the Customer** ("Controller") and **the Operator** ("Processor"),
effective _[YYYY-MM-DD]_.

> Template for business customers. Adapt to the processor obligations of GDPR
> Art. 28. Not legal advice.

## 1. Scope

The Processor provides the hosted API service described in `TERMS.md` and
processes personal data only as necessary to deliver it.

## 2. Subject matter and duration

- **Subject matter:** routing API requests to upstream model providers and
  recording usage metadata.
- **Duration:** the term of the underlying service agreement plus the retention
  periods in `PRIVACY.md`.

## 3. Categories of data and data subjects

- Data subjects: the Controller's end users and personnel.
- Data: API-key identifiers (hashed), account identifiers, usage metadata,
  abuse signals. Prompt/completion content is **not persisted** by the Processor.

## 4. Processor obligations

1. Process data only on documented instructions from the Controller.
2. Ensure confidentiality of personnel with access.
3. Implement the technical and organisational measures in §7.
4. Assist the Controller with data-subject requests.
5. Notify the Controller without undue delay (target: 48 hours) of a personal
   data breach.
6. Delete or return data at the end of the agreement (see `PRIVACY.md`).
7. Permit audits at reasonable notice, at most once per year.
8. Engage sub-processors only with prior written authorisation; current
   sub-processors: _[model providers]_, _[hosting provider]_.

## 5. Controller obligations

The Controller is responsible for the lawfulness of its instructions and for
informing its end users.

## 6. International transfers

Transfers outside the EEA rely on _[Standard Contractual Clauses / adequacy]_;
the annex of the SCCs is incorporated by reference.

## 7. Security measures

- Encryption in transit (TLS) for all external traffic.
- API keys hashed at rest (SHA-256); plaintext never stored.
- Management API bound to loopback; remote access requires a bearer token.
- Per-key quotas, spend caps, and abuse detection.
- Access to production data limited to the operator.

## 8. Liability

Liability is governed by the underlying service agreement.

---

**Controller:** _[name, address, signature, date]_
**Processor:** _[name, address, signature, date]_
