import * as Ucanto from '@ucanto/interface'
import {
  delegationsToBytes,
  bytesToDelegations,
} from '@web3-storage/access/encoding'

/**
 * @typedef {import('../types/access-api-cf-db').R2Bucket} R2Bucket
 */

/**
 * @template {import('../types/access-api-cf-db').DelegationsV3Row} DelegationRow
 * @typedef {Omit<DelegationRow, 'inserted_at'|'updated_at'|'expires_at'>} DelegationRowUpdate
 */

/**
 * @template Tables
 * @typedef {import("../types/database").Database<Tables>} Database
 */

export const delegationsV2TableName = /** @type {const} */ ('delegations_v2')

/**
 * indicates that processing failed due to encountering an unexpected delegation.
 * e.g. if a delegation could not be parsed from underlying storage
 */
export class UnexpectedDelegation extends Error {
  name = 'UnexpectedDelegation'
}

/**
 * @param {Ucanto.Delegation} d
 * @returns {DelegationRowUpdate<import('../types/access-api-cf-db').DelegationsV3Row>}
 */
export function createDelegationRowUpdateV3(d) {
  return {
    cid: d.cid.toV1().toString(),
    audience: d.audience.did(),
    issuer: d.issuer.did(),
  }
}

/**
 * @param {Array<number> | Buffer | unknown} sqlValue - value from kysely 'bytes' table - in node it could be a Buffer. In cloudflare it might be an Array
 * @returns {ArrayBuffer|undefined} - undefined if unable to convert
 */
export function delegationsTableBytesToArrayBuffer(sqlValue) {
  if (ArrayBuffer.isView(sqlValue)) {
    return new Uint8Array(
      sqlValue.buffer,
      sqlValue.byteOffset,
      sqlValue.byteLength
    )
  }
  if (Array.isArray(sqlValue)) {
    return Uint8Array.from(sqlValue)
  }
}

export const delegationsV3Table = /** @type {const} */ (`delegations_v3`)

/**
 * @template {Database<import('../types/access-api-cf-db').DelegationsV3Tables>} DB
 */
export class DbDelegationsStorageWithR2 {
  // @todo abstract away R2 specifics into DagStore: ~AsyncMap<CID, Ucanto.Delegation>
  /** @type {R2Bucket} */
  #dags
  /** @type {DB} */
  #db
  #delegationsTableName = delegationsV3Table
  /* @type {(d: { cid: string }) => string} */
  #getDagsKey = carFileKeyer

  /**
   * @param {DB} db
   * @param {R2Bucket} dags
   */
  constructor(db, dags) {
    this.#db = db
    this.#dags = dags
    // eslint-disable-next-line no-void
    void (
      /** @type {import('../types/delegations').DelegationsStorage} */ (this)
    )
  }

  /**
   * store items
   *
   * @param  {Array<Ucanto.Delegation>} delegations
   * @returns {Promise<void>}
   */
  async putMany(...delegations) {
    if (delegations.length === 0) {
      return
    }
    await writeDelegations(this.#dags, delegations, this.#getDagsKey)
    const values = delegations.map((d) => createDelegationRowUpdateV3(d))
    // @todo - if this fails, undo writeDelegations that dont need to be stored
    await this.#db
      .insertInto(this.#delegationsTableName)
      .values(values)
      .onConflict((oc) => oc.column('cid').doNothing())
      .executeTakeFirst()
  }

  /** @returns {Promise<bigint>} */
  async count() {
    return count(this.#db, this.#delegationsTableName)
  }

  /**
   * @param {import('../types/delegations').Query} query
   */
  async *find(query) {
    const { audience } = query
    const delegations = this.#delegationsTableName
    const selection = await this.#db
      .selectFrom(delegations)
      .select(['cid'])
      .where(`${delegations}.audience`, '=', audience)
      .execute()
    for await (const row of selection) {
      yield this.#rowToDelegation(row)
    }
  }

  async *[Symbol.asyncIterator]() {
    if (!this.#db.canStream) {
      throw Object.assign(
        new Error(
          `cannot create asyncIterator because the underlying database does not support streaming`
        ),
        { name: 'NotImplementedError' }
      )
    }
    for await (const row of this.#db
      .selectFrom(this.#delegationsTableName)
      .select(['cid'])
      .stream()) {
      yield this.#rowToDelegation(row)
    }
  }

  /**
   * @param {Pick<import('../types/access-api-cf-db').DelegationsV3Row, 'cid'>} row
   * @param {R2Bucket} dags
   * @param {(d: { cid: string }) => string} keyer - builds k/v key strings for each delegation
   * @returns {Promise<Ucanto.Delegation>}
   */
  async #rowToDelegation(row, dags = this.#dags, keyer = this.#getDagsKey) {
    const cidString = row.cid.toString()
    const carBytesR2 = await dags.get(keyer({ cid: cidString }))
    if (!carBytesR2) {
      throw new Error(`failed to read car bytes for cid ${cidString}`)
    }
    const carBytes = new Uint8Array(await carBytesR2.arrayBuffer())
    const delegations = bytesToDelegations(carBytes)
    if (delegations.length !== 1) {
      throw new Error(
        `expected 1 delegation in CAR, but got ${delegations.length}`
      )
    }
    const [delegation] = delegations
    return delegation
  }
}

/**
 * @typedef {import('../types/access-api-cf-db').DelegationsV3Row} DelegationsV3Row
 */

/**
 * @template {string} TableName
 * @template {Record<TableName, DelegationsV3Row>} Tables
 * @param {import('../types/database').Database<Tables>} db
 * @param {TableName} delegationsTable
 * @returns {Promise<bigint>} - count of table
 */
async function count(db, delegationsTable) {
  const { size } = await db
    .selectFrom(delegationsTable)
    .select((e) => e.fn.count('cid').as('size'))
    .executeTakeFirstOrThrow()
  return BigInt(size)
}

/**
 * @param {{ cid: string }} ucan
 */
function carFileKeyer(ucan) {
  return /** @type {const} */ (`${ucan.cid.toString()}.car`)
}

/**
 * @param {R2Bucket} bucket
 * @param {Iterable<Ucanto.Delegation>} delegations
 * @param {(d: { cid: string }) => string} keyer - builds k/v key strings for each delegation
 */
async function writeDelegations(bucket, delegations, keyer) {
  return writeEntries(
    bucket,
    [...delegations].map((delegation) => {
      const key = keyer({ cid: delegation.cid.toString() })
      const carBytes = delegationsToBytes([delegation])
      const value = carBytes
      return /** @type {[key: string, value: Uint8Array]} */ ([key, value])
    })
  )
}

/**
 * @param {R2Bucket} bucket
 * @param {Iterable<readonly [key: string, value: Uint8Array ]>} entries
 */
async function writeEntries(bucket, entries) {
  await Promise.all([...entries].map(([key, value]) => bucket.put(key, value)))
}
