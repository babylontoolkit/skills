'use strict';

/** The server refused this helper's protocol version (HTTP 426). */
class UpdateRequiredError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UpdateRequiredError';
  }
}

/** The device token is unknown or revoked (HTTP 401). */
class NotPairedError extends Error {
  /** @param {string} [message] */
  constructor(message = 'This device is not paired.') {
    super(message);
    this.name = 'NotPairedError';
  }
}

/**
 * Minimal JSON client for the App Builder's bridge routes. The token travels only in the
 * `authorization` header, never in a URL (D8).
 */
class BridgeApi {
  /**
   * @param {string} server origin, no trailing slash
   * @param {string} [token]
   */
  constructor(server, token) {
    this.server = server;
    this.token = token;
  }

  /**
   * @param {string} path
   * @param {unknown} body
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ status: number, body: any }>}
   */
  async post(path, body, signal) {
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const res = await fetch(`${this.server}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal,
    });

    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }

    if (res.status === 426) {
      throw new UpdateRequiredError(
        (parsed && typeof parsed.message === 'string' && parsed.message) ||
          'This Desktop Agent is too old for the App Builder.'
      );
    }
    if (res.status === 401) {
      throw new NotPairedError((parsed && typeof parsed.message === 'string' && parsed.message) || undefined);
    }

    return { status: res.status, body: parsed };
  }
}

module.exports = { BridgeApi, UpdateRequiredError, NotPairedError };
