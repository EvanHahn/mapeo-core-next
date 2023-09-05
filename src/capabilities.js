import { currentSchemaVersions } from '@mapeo/schema'
import mapObject from 'map-obj'
import { kCreateWithDocId } from './datatype/index.js'

// Randomly generated 8-byte encoded as hex
export const COORDINATOR_ROLE_ID = 'f7c150f5a3a9a855'
export const MEMBER_ROLE_ID = '012fd2d431c0bf60'
export const BLOCKED_ROLE_ID = '9e6d29263cba36c9'

/**
 * @typedef {object} DocCapability
 * @property {boolean} readOwn - can read own data
 * @property {boolean} writeOwn - can write own data
 * @property {boolean} readOthers - can read other's data
 * @property {boolean} writeOthers - can edit or delete other's data
 */

/**
 * @typedef {object} Capability
 * @property {string} name
 * @property {Record<import('@mapeo/schema').MapeoDoc['schemaName'], DocCapability>} docs
 * @property {RoleId[]} roleAssignment
 * @property {'allowed' | 'blocked'} sync
 */

/**
 * @typedef {typeof COORDINATOR_ROLE_ID | typeof MEMBER_ROLE_ID | typeof BLOCKED_ROLE_ID} RoleId
 */

/**
 * This is currently the same as 'Coordinator' capabilities, but defined
 * separately because the creator should always have ALL capabilities, but we
 * could edit 'Coordinator' capabilities in the future
 *
 * @type {Capability}
 */
export const CREATOR_CAPABILITIES = {
  name: 'Project Creator',
  docs: mapObject(currentSchemaVersions, (key) => {
    return [
      key,
      { readOwn: true, writeOwn: true, readOthers: true, writeOthers: true },
    ]
  }),
  roleAssignment: [COORDINATOR_ROLE_ID, MEMBER_ROLE_ID, BLOCKED_ROLE_ID],
  sync: 'allowed',
}

/** @type {Record<RoleId, Capability>} */
export const DEFAULT_CAPABILITIES = {
  [MEMBER_ROLE_ID]: {
    name: 'Member',
    docs: mapObject(currentSchemaVersions, (key) => {
      return [
        key,
        { readOwn: true, writeOwn: true, readOthers: true, writeOthers: false },
      ]
    }),
    roleAssignment: [],
    sync: 'allowed',
  },
  [COORDINATOR_ROLE_ID]: {
    name: 'Coordinator',
    docs: mapObject(currentSchemaVersions, (key) => {
      return [
        key,
        { readOwn: true, writeOwn: true, readOthers: true, writeOthers: true },
      ]
    }),
    roleAssignment: [COORDINATOR_ROLE_ID, MEMBER_ROLE_ID, BLOCKED_ROLE_ID],
    sync: 'allowed',
  },
  [BLOCKED_ROLE_ID]: {
    name: 'Blocked',
    docs: mapObject(currentSchemaVersions, (key) => {
      return [
        key,
        {
          readOwn: false,
          writeOwn: false,
          readOthers: false,
          writeOthers: false,
        },
      ]
    }),
    roleAssignment: [],
    sync: 'blocked',
  },
}

export class Capabilities {
  #dataType
  #coreOwnership
  #coreManager
  #projectCreatorAuthCoreId
  #ownDeviceId

  /**
   *
   * @param {object} opts
   * @param {import('./datatype/index.js').DataType<
   *   import('./datastore/index.js').DataStore<'auth'>,
   *   typeof import('./schema/project.js').roleTable,
   *   'role',
   *   import('@mapeo/schema').Role,
   *   import('@mapeo/schema').RoleValue
   * >} opts.dataType
   * @param {import('./core-ownership.js').CoreOwnership} opts.coreOwnership
   * @param {import('./core-manager/index.js').CoreManager} opts.coreManager
   * @param {Buffer} opts.projectKey
   * @param {Buffer} opts.deviceKey public key of this device
   */
  constructor({ dataType, coreOwnership, coreManager, projectKey, deviceKey }) {
    this.#dataType = dataType
    this.#coreOwnership = coreOwnership
    this.#coreManager = coreManager
    this.#projectCreatorAuthCoreId = projectKey.toString('hex')
    this.#ownDeviceId = deviceKey.toString('hex')
  }

  /**
   * Get the capabilities for device `deviceId`.
   *
   * @param {string} deviceId
   * @returns {Promise<Capability>}
   */
  async getCapabilities(deviceId) {
    let roleId
    try {
      const roleAssignment = await this.#dataType.getByDocId(deviceId)
      roleId = roleAssignment.roleId
    } catch (e) {
      // The project creator will have all capabilities
      const authCoreId = await this.#coreOwnership.getCoreId(deviceId, 'auth')
      if (authCoreId === this.#projectCreatorAuthCoreId) {
        return CREATOR_CAPABILITIES
      } else {
        return DEFAULT_CAPABILITIES[BLOCKED_ROLE_ID]
      }
    }
    if (!isKnownRoleId(roleId)) {
      return DEFAULT_CAPABILITIES[BLOCKED_ROLE_ID]
    }
    const capabilities = DEFAULT_CAPABILITIES[roleId]
    return capabilities
  }

  /**
   * Assign a role to the specified `deviceId`. Devices without an assigned role
   * are unable to sync, except the project creator that defaults to having all
   * capabilities. Only the project creator can assign their own role. Will
   * throw if the device trying to assign the role lacks the `roleAssignment`
   * capability for the given roleId
   *
   * @param {string} deviceId
   * @param {keyof DEFAULT_CAPABILITIES} roleId
   */
  async assignRole(deviceId, roleId) {
    let fromIndex = 0
    let authCoreId
    try {
      authCoreId = await this.#coreOwnership.getCoreId(deviceId, 'auth')
      const authCoreKey = Buffer.from(authCoreId, 'hex')
      const authCore = this.#coreManager.getCoreByKey(authCoreKey)
      if (authCore) {
        await authCore.ready()
        fromIndex = authCore.length
      }
    } catch {
      // This will usually happen when assigning a role to a newly invited
      // device that has not yet synced (so we do not yet have a replica of
      // their authCore). In this case we want fromIndex to be 0
    }
    const isAssigningProjectCreatorRole =
      authCoreId === this.#projectCreatorAuthCoreId
    if (isAssigningProjectCreatorRole && !this.#isProjectCreator()) {
      throw new Error(
        "Only the project creator can assign the project creator's role"
      )
    }
    const ownCapabilities = await this.getCapabilities(this.#ownDeviceId)
    if (!ownCapabilities.roleAssignment.includes(roleId)) {
      throw new Error('No capability to assign role ' + roleId)
    }
    await this.#dataType[kCreateWithDocId](deviceId, {
      schemaName: 'role',
      roleId,
      fromIndex,
    })
  }

  async #isProjectCreator() {
    const ownAuthCoreId = this.#coreManager
      .getWriterCore('auth')
      .key.toString('hex')
    return ownAuthCoreId === this.#projectCreatorAuthCoreId
  }
}

/**
 *
 * @param {string} roleId
 * @returns {roleId is keyof DEFAULT_CAPABILITIES}
 */
function isKnownRoleId(roleId) {
  return roleId in DEFAULT_CAPABILITIES
}