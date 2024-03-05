import * as API from '../types.js'
import * as DB from 'datalogia'
import * as Capability from '../agent/capability.js'
import * as Delegation from '../agent/delegation.js'
import * as Text from '../agent/db/text.js'
import * as Attestation from '../agent/attestation.js'

export { Capability, Delegation, Text }

/**
 * @typedef {object} ProofSelector
 * @property {DB.Term<string>} can
 * @property {DB.Term<DB.Entity>} proof
 * @property {DB.Term<DB.Entity>} [attestation]
 * @property {string} [need]
 *
 * @typedef {object} Selector
 * @property {DB.Term<API.DID>} audience
 * @property {DB.Term<API.DID>} subject
 * @property {ProofSelector[]} proofs
 */

/**
 * Creates query that select set of proofs that would allow the
 * `selector.audience` to invoke abilities described in `selector.can` on the
 * `selector.subject` when time is `selector.time`.
 *
 * @param {object} selector
 * @param {API.TextConstraint} selector.audience
 * @param {API.Can} [selector.can]
 * @param {API.TextConstraint} [selector.subject]
 * @param {API.UTCUnixTimestamp} [selector.time]
 * @returns {API.Query<Selector>}
 */
export const query = ({ can = {}, time = Date.now() / 1000, ...selector }) => {
  const subject = DB.string()
  const audience = DB.string()
  // Get all abilities we will try to find proofs for, at the moment we do not
  // allow passing constraints which is why we simply use keys.
  const need = Object.keys(can)
  // For each requested ability we generate group of corresponding variables
  // that we will try to resolve, however if no abilities were requested we
  // will generate a single group without `need` field.
  const proofs = (need.length > 0 ? need : [undefined]).map((need) => ({
    // Issuer of the proof
    issuer: DB.string(),
    // Ability that is delegated
    can: DB.string(),
    // Proof that delegates needed ability
    proof: DB.link(),
    // Attestation for the given proof if it was issued by an account did.
    attestation: DB.link(),
    // Omit need if it was not provided
    ...(need && { need }),
  }))

  // Here we generate selector clause for each proof that we will try to match
  const where = proofs.map(({ proof, issuer, need, can, attestation }) => {
    // main clause will find a relevant proof.
    const clause = match(proof, {
      subject,
      can,
      audience,
      issuer,
      time,
    })

    // Then we try to find an attestations for the proof, however attestations
    // are required only for `did:mailto:` issued proofs, there for we compose
    // this confusing `or` clause that succeeds either when proof was not
    // issued by `did:mailto:` principal or when we have an attestation for
    // the found proof.
    const attestations = DB.or(
      DB.not(DB.Constraint.glob(issuer, 'did:mailto:*')),
      Attestation.match(attestation, { proof, time, audience })
    )

    // If `need` was provided we constraint `can` of the proof by it, if it
    // was not provided we are looking for all proofs so we do not restrict it.
    // We also join primary clause with attestation clause so that only proofs
    // matched either do not require attestations or are accompanied by them.
    return (need ? clause.and(DB.glob(need, can)) : clause).and(attestations)
  })

  return {
    select: {
      proofs,
      subject,
      audience,
    },
    where: [
      ...where,
      // If subject pattern was provided we constraint matches by it.
      Text.match(subject, selector.subject ?? { glob: '*' }),
      // If audience was provided we constraint matches by it.
      Text.match(audience, selector.audience),
    ],
  }
}

/**
 * Matches a delegation that authorizes the `selector.audience` with an ability
 * to invoke `selector.can` on `selector.subject` at `selector.time`. Please note
 * that it will only match explicit authorization that is one that specifies
 * `selector.subject` and will not match implicit authorizations that uses
 * `ucan:*` capability.
 *
 * @param {DB.Term<DB.Link>} delegation
 * @param {object} selector
 * @param {DB.Term<API.UTCUnixTimestamp>} [selector.time]
 * @param {DB.Term<string>} [selector.can]
 * @param {DB.Term<string>} [selector.subject]
 * @param {DB.Term<API.DID>} [selector.audience]
 * @param {DB.Term<API.DID>} [selector.issuer]
 */
export const explicit = (
  delegation,
  {
    audience = DB.string(),
    issuer = DB.string(),
    subject = DB.string(),
    can = DB.string(),
    time = DB.integer(),
  }
) => {
  const capability = DB.link()

  return Capability.match(capability, { can, subject }).and(
    Delegation.match(delegation, {
      capability,
      audience,
      issuer,
      time,
    })
  )
}

/**
 * Matches a delegation that authorizes the `selector.audience` with an ability
 * to invoke `selector.can` on `selector.subject` at `selector.time`. Please note
 * that it will only match implicit authorization that is one that has `ucan:*`
 * subject and is either issued by `selector.subject` or has a proof which
 * explicitly delegates `selector.can` to `selector.subject`.
 *
 * @param {DB.Term<DB.Link>} delegation
 * @param {object} selector
 * @param {DB.Term<API.UTCUnixTimestamp>} [selector.time]
 * @param {DB.Term<API.Ability>} [selector.can]
 * @param {DB.Term<API.DID>} [selector.subject]
 * @param {DB.Term<API.DID>} [selector.audience]
 * @param {DB.Term<API.DID>} [selector.issuer]
 * @returns {DB.Clause}
 */
export const implicit = (
  delegation,
  {
    subject = DB.string(),
    can = DB.string(),
    time = DB.integer(),
    audience = DB.string(),
    issuer = DB.string(),
  }
) => {
  const proof = DB.link()
  return DB.and(
    Delegation.forwards(delegation, {
      issuer,
      audience,
      can,
      time,
    }),
    DB.or(
      Delegation.issuedBy(delegation, subject),
      DB.and(
        Delegation.hasProof(delegation, proof),
        DB.or(
          explicit(proof, { audience: issuer, subject, can, time })
          // TODO: Add support for recursive implicit delegation
          // implicit(proof, { subject, can, time, audience })
        )
      )
    )
  )
}

/**
 * Matches a delegation that authorizes the `selector.audience` with an ability
 * to invoke `selector.can` on `selector.subject` at `selector.time`. It will
 * match both explicit and implicit authorizations.
 *
 * @param {DB.Term<DB.Link>} delegation
 * @param {object} selector
 * @param {DB.Term<API.UTCUnixTimestamp>} [selector.time]
 * @param {DB.Term<API.Ability>} [selector.can]
 * @param {DB.Term<API.DID>} [selector.subject]
 * @param {DB.Term<API.DID>} [selector.audience]
 * @param {DB.Term<API.DID>} [selector.issuer]
 */
export const match = (
  delegation,
  {
    audience = DB.string(),
    subject = DB.string(),
    issuer = DB.string(),
    can = DB.string(),
    time = DB.integer(),
  }
) =>
  DB.or(
    explicit(delegation, { issuer, audience, can, subject, time }),
    implicit(delegation, { issuer, audience, can, subject, time })
  )
