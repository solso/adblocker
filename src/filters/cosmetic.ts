import * as punycode from 'punycode';
import StaticDataView from '../data-view';
import { binLookup, fastStartsWithFrom, getBit, hasUnicode, setBit } from '../utils';
import IFilter from './interface';

export const DEFAULT_HIDDING_STYLE: string = 'display: none !important;';

export function hashHostnameBackward(hostname: string): number {
  let hash = 5381;
  for (let j = hostname.length - 1; j >= 0; j -= 1) {
    hash = (hash * 33) ^ hostname.charCodeAt(j);
  }
  return hash >>> 0;
}

export function getHashesFromLabelsBackward(
  hostname: string,
  end: number,
  startOfDomain: number,
): number[] {
  const hashes: number[] = [];
  let hash = 5381;

  // Compute hash backward, label per label
  for (let i = end - 1; i >= 0; i -= 1) {
    // Process label
    if (hostname[i] === '.' && i < startOfDomain) {
      hashes.push(hash >>> 0);
    }

    // Update hash
    hash = (hash * 33) ^ hostname.charCodeAt(i);
  }

  hashes.push(hash >>> 0);
  return hashes;
}

export function getEntityHashesFromLabelsBackward(hostname: string, domain: string): number[] {
  const hostnameWithoutPublicSuffix = getHostnameWithoutPublicSuffix(hostname, domain);
  if (hostnameWithoutPublicSuffix !== null) {
    return getHashesFromLabelsBackward(
      hostnameWithoutPublicSuffix,
      hostnameWithoutPublicSuffix.length,
      hostnameWithoutPublicSuffix.length,
    );
  }
  return [];
}

export function getHostnameHashesFromLabelsBackward(hostname: string, domain: string): number[] {
  return getHashesFromLabelsBackward(hostname, hostname.length, hostname.length - domain.length);
}

/**
 * Given a hostname and its domain, return the hostname without the public
 * suffix. We know that the domain, with one less label on the left, will be a
 * the public suffix; and from there we know which trailing portion of
 * `hostname` we should remove.
 */
export function getHostnameWithoutPublicSuffix(hostname: string, domain: string): string | null {
  let hostnameWithoutPublicSuffix: string | null = null;

  const indexOfDot = domain.indexOf('.');
  if (indexOfDot !== -1) {
    const publicSuffix = domain.slice(indexOfDot + 1);
    hostnameWithoutPublicSuffix = hostname.slice(0, -publicSuffix.length - 1);
  }

  return hostnameWithoutPublicSuffix;
}

/**
 * Validate CSS selector. There is a fast path for simple selectors (e.g.: #foo
 * or .bar) which are the most common case. For complex ones, we rely on
 * `Element.matches` (if available).
 */
const isValidCss = (() => {
  const div =
    typeof document !== 'undefined'
      ? document.createElement('div')
      : {
          matches: () => {
            /* noop */
          },
        };
  const matches = (selector: string): void | boolean => div.matches(selector);
  const validSelectorRe = /^[#.]?[\w-.]+$/;

  return function isValidCssImpl(selector: string): boolean {
    if (validSelectorRe.test(selector)) {
      return true;
    }

    try {
      matches(selector);
    } catch (ex) {
      return false;
    }

    return true;
  };
})();

/**
 * Masks used to store options of cosmetic filters in a bitmask.
 */
const enum COSMETICS_MASK {
  unhide = 1 << 0,
  scriptInject = 1 << 1,
  scriptBlock = 1 << 2,
}

function computeFilterId(
  mask: number,
  selector: string | undefined,
  hostnames: Uint32Array | undefined,
  entities: Uint32Array | undefined,
  notHostnames: Uint32Array | undefined,
  notEntities: Uint32Array | undefined,
): number {
  let hash = (5408 * 33) ^ mask;

  if (selector !== undefined) {
    for (let i = 0; i < selector.length; i += 1) {
      hash = (hash * 33) ^ selector.charCodeAt(i);
    }
  }

  if (hostnames !== undefined) {
    for (let i = 0; i < hostnames.length; i += 1) {
      hash = (hash * 33) ^ hostnames[i];
    }
  }

  if (entities !== undefined) {
    for (let i = 0; i < entities.length; i += 1) {
      hash = (hash * 33) ^ entities[i];
    }
  }

  if (notHostnames !== undefined) {
    for (let i = 0; i < notHostnames.length; i += 1) {
      hash = (hash * 33) ^ notHostnames[i];
    }
  }

  if (notEntities !== undefined) {
    for (let i = 0; i < notEntities.length; i += 1) {
      hash = (hash * 33) ^ notEntities[i];
    }
  }

  return hash >>> 0;
}

/***************************************************************************
 *  Cosmetic filters parsing
 * ************************************************************************ */

/**
 * TODO: Make sure these are implemented properly and write tests.
 * - -abp-contains
 * - -abp-has
 * - contains
 * - has
 * - has-text
 * - if
 * - if-not
 * - matches-css
 * - matches-css-after
 * - matches-css-before
 * - xpath
 */
export default class CosmeticFilter implements IFilter {
  /**
   * Given a line that we know contains a cosmetic filter, create a CosmeticFiler
   * instance out of it. This function should be *very* efficient, as it will be
   * used to parse tens of thousands of lines.
   */
  public static parse(line: string, debug: boolean = false): CosmeticFilter | null {
    // Mask to store attributes
    // Each flag (unhide, scriptInject, etc.) takes only 1 bit
    // at a specific offset defined in COSMETICS_MASK.
    // cf: COSMETICS_MASK for the offset of each property
    let mask = 0;
    let selector: string | undefined;
    let hostnames: Uint32Array | undefined;
    let notHostnames: Uint32Array | undefined;
    let entities: Uint32Array | undefined;
    let notEntities: Uint32Array | undefined;
    let style: string | undefined;
    const sharpIndex = line.indexOf('#');

    // Start parsing the line
    const afterSharpIndex = sharpIndex + 1;
    let suffixStartIndex = afterSharpIndex + 1;

    // hostname1,hostname2#@#.selector
    //                    ^^ ^
    //                    || |
    //                    || suffixStartIndex
    //                    |afterSharpIndex
    //                    sharpIndex

    // Check if unhide
    if (line.length > afterSharpIndex && line[afterSharpIndex] === '@') {
      mask = setBit(mask, COSMETICS_MASK.unhide);
      suffixStartIndex += 1;
    }

    // Parse hostnames and entitites as well as their negations.
    //
    // - ~hostname##.selector
    // - hostname##.selector
    // - entity.*##.selector
    // - ~entity.*##.selector
    //
    // Each kind will have its own Uint32Array containing hashes, sorted by
    // number of labels considered. This allows a compact representation of
    // hostnames and fast matching without any string copy.
    if (sharpIndex > 0) {
      const entitiesArray: number[] = [];
      const notEntitiesArray: number[] = [];
      const hostnamesArray: number[] = [];
      const notHostnamesArray: number[] = [];

      // TODO - this could be done without any string copy
      line
        .slice(0, sharpIndex)
        .split(',')
        .forEach((hostname) => {
          if (hasUnicode(hostname)) {
            hostname = punycode.encode(hostname);
          }

          const negation: boolean = hostname[0] === '~';
          const entity: boolean = hostname.endsWith('.*');

          const start: number = negation ? 1 : 0;
          const end: number = entity ? hostname.length - 2 : hostname.length;

          const hash = hashHostnameBackward(hostname.slice(start, end));

          if (negation) {
            if (entity) {
              notEntitiesArray.push(hash);
            } else {
              notHostnamesArray.push(hash);
            }
          } else {
            if (entity) {
              entitiesArray.push(hash);
            } else {
              hostnamesArray.push(hash);
            }
          }
        });

      if (entitiesArray.length !== 0) {
        entities = new Uint32Array(entitiesArray).sort();
      }

      if (hostnamesArray.length !== 0) {
        hostnames = new Uint32Array(hostnamesArray).sort();
      }

      if (notEntitiesArray.length !== 0) {
        notEntities = new Uint32Array(notEntitiesArray).sort();
      }

      if (notHostnamesArray.length !== 0) {
        notHostnames = new Uint32Array(notHostnamesArray).sort();
      }
    }

    // We should not have unhide without any hostname
    // NOTE: it does not make sense either to only have a negated domain or
    // entity (e.g.: ~domain.com or ~entity.*), these are thus ignored.
    if (getBit(mask, COSMETICS_MASK.unhide) && hostnames === undefined && entities === undefined) {
      return null;
    }

    // Deal with script:inject and script:contains
    if (fastStartsWithFrom(line, 'script:', suffixStartIndex)) {
      //      script:inject(.......)
      //                    ^      ^
      //   script:contains(/......./)
      //                    ^      ^
      //    script:contains(selector[, args])
      //           ^        ^               ^^
      //           |        |          |    ||
      //           |        |          |    |selector.length
      //           |        |          |    scriptSelectorIndexEnd
      //           |        |          |scriptArguments
      //           |        scriptSelectorIndexStart
      //           scriptMethodIndex
      const scriptMethodIndex = suffixStartIndex + 7;
      let scriptSelectorIndexStart = scriptMethodIndex;
      let scriptSelectorIndexEnd = line.length - 1;

      if (fastStartsWithFrom(line, 'inject(', scriptMethodIndex)) {
        mask = setBit(mask, COSMETICS_MASK.scriptInject);
        scriptSelectorIndexStart += 7;
      } else if (fastStartsWithFrom(line, 'contains(', scriptMethodIndex)) {
        mask = setBit(mask, COSMETICS_MASK.scriptBlock);
        scriptSelectorIndexStart += 9;

        // If it's a regex
        if (line[scriptSelectorIndexStart] === '/' && line[scriptSelectorIndexEnd - 1] === '/') {
          scriptSelectorIndexStart += 1;
          scriptSelectorIndexEnd -= 1;
        }
      }

      selector = line.slice(scriptSelectorIndexStart, scriptSelectorIndexEnd);
    } else if (fastStartsWithFrom(line, '+js(', suffixStartIndex)) {
      mask = setBit(mask, COSMETICS_MASK.scriptInject);
      selector = line.slice(suffixStartIndex + 4, line.length - 1);
    } else {
      // Detect special syntax
      let indexOfColon = line.indexOf(':', suffixStartIndex);
      while (indexOfColon !== -1) {
        const indexAfterColon = indexOfColon + 1;
        if (fastStartsWithFrom(line, 'style', indexAfterColon)) {
          // ##selector :style(...)
          if (line[indexAfterColon + 5] === '(' && line[line.length - 1] === ')') {
            selector = line.slice(suffixStartIndex, indexOfColon);
            style = line.slice(indexAfterColon + 6, -1);
          } else {
            return null;
          }
        } else if (
          fastStartsWithFrom(line, '-abp-', indexAfterColon) ||
          fastStartsWithFrom(line, 'contains', indexAfterColon) ||
          fastStartsWithFrom(line, 'has', indexAfterColon) ||
          fastStartsWithFrom(line, 'if', indexAfterColon) ||
          fastStartsWithFrom(line, 'if-not', indexAfterColon) ||
          fastStartsWithFrom(line, 'matches-css', indexAfterColon) ||
          fastStartsWithFrom(line, 'matches-css-after', indexAfterColon) ||
          fastStartsWithFrom(line, 'matches-css-before', indexAfterColon) ||
          fastStartsWithFrom(line, 'not', indexAfterColon) ||
          fastStartsWithFrom(line, 'properties', indexAfterColon) ||
          fastStartsWithFrom(line, 'subject', indexAfterColon) ||
          fastStartsWithFrom(line, 'xpath', indexAfterColon)
        ) {
          return null;
        }
        indexOfColon = line.indexOf(':', indexAfterColon);
      }

      // If we reach this point, filter is not extended syntax
      if (selector === undefined && suffixStartIndex < line.length) {
        selector = line.slice(suffixStartIndex);
      }

      if (selector === undefined || !isValidCss(selector)) {
        // Not a valid selector
        return null;
      }
    }

    return new CosmeticFilter({
      entities,
      hostnames,
      mask,
      notEntities,
      notHostnames,
      rawLine: debug === true ? line : undefined,
      selector,
      style,
    });
  }

  /**
   * Deserialize cosmetic filters. The code accessing the buffer should be
   * symetrical to the one in `serializeCosmeticFilter`.
   */
  public static deserialize(buffer: StaticDataView): CosmeticFilter {
    const mask = buffer.getUint8();
    const selector = buffer.getUTF8();
    const optionalParts = buffer.getUint8();

    // The order of these fields should be the same as when we serialize them.
    return new CosmeticFilter({
      // Mandatory fields
      mask,
      selector,

      // Optional fields
      entities: (optionalParts & 1) === 1 ? buffer.getUint32Array() : undefined,
      hostnames: (optionalParts & 2) === 2 ? buffer.getUint32Array() : undefined,
      notEntities: (optionalParts & 4) === 4 ? buffer.getUint32Array() : undefined,
      notHostnames: (optionalParts & 8) === 8 ? buffer.getUint32Array() : undefined,
      rawLine: (optionalParts & 16) === 16 ? buffer.getUTF8() : undefined,
      style: (optionalParts & 32) === 32 ? buffer.getASCII() : undefined,
    });
  }

  public readonly mask: number;
  public readonly selector: string;

  // hostnames
  public readonly hostnames?: Uint32Array;
  public readonly entities?: Uint32Array;

  // Exceptions
  public readonly notHostnames?: Uint32Array;
  public readonly notEntities?: Uint32Array;

  public readonly style?: string;

  public id?: number;
  public rawLine?: string;

  constructor({
    entities,
    hostnames,
    mask,
    notEntities,
    notHostnames,
    rawLine,
    selector,
    style,
  }: Partial<CosmeticFilter> & { mask: number; selector: string }) {
    this.entities = entities;
    this.hostnames = hostnames;
    this.mask = mask;
    this.notEntities = notEntities;
    this.notHostnames = notHostnames;
    this.rawLine = rawLine;
    this.selector = selector;
    this.style = style;
  }

  public isCosmeticFilter(): boolean {
    return true;
  }

  public isNetworkFilter(): boolean {
    return false;
  }

  /**
   * The format of a cosmetic filter is:
   *
   * | mask | selector length | selector... | hostnames length | hostnames...
   *   32     16                              16
   *
   * The header (mask) is 32 bits, then we have a total of 32 bits to store the
   * length of `selector` and `hostnames` (16 bits each).
   *
   * Improvements similar to the onces mentioned in `serializeNetworkFilters`
   * could be applied here, to get a more compact representation.
   */
  public serialize(buffer: StaticDataView): void {
    // Mandatory fields
    buffer.pushUint8(this.mask);
    buffer.pushUTF8(this.selector);

    const index = buffer.getPos();
    buffer.pushUint8(0);

    // This bit-mask indicates which optional parts of the filter were serialized.
    let optionalParts = 0;

    if (this.entities !== undefined) {
      optionalParts |= 1;
      buffer.pushUint32Array(this.entities);
    }

    if (this.hostnames !== undefined) {
      optionalParts |= 2;
      buffer.pushUint32Array(this.hostnames);
    }

    if (this.notEntities !== undefined) {
      optionalParts |= 4;
      buffer.pushUint32Array(this.notEntities);
    }

    if (this.notHostnames !== undefined) {
      optionalParts |= 8;
      buffer.pushUint32Array(this.notHostnames);
    }

    if (this.rawLine !== undefined) {
      optionalParts |= 16;
      buffer.pushUTF8(this.rawLine);
    }

    if (this.style !== undefined) {
      optionalParts |= 32;
      buffer.pushASCII(this.style);
    }

    buffer.setByte(index, optionalParts);
  }

  /**
   * Create a more human-readable version of this filter. It is mainly used for
   * debugging purpose, as it will expand the values stored in the bit mask.
   */
  public toString(): string {
    if (this.rawLine !== undefined) {
      return this.rawLine;
    }

    let filter = '';

    if (
      this.hostnames !== undefined ||
      this.entities !== undefined ||
      this.notHostnames !== undefined ||
      this.notEntities !== undefined
    ) {
      filter += '<hostnames>';
    }

    if (this.isUnhide()) {
      filter += '#@#';
    } else {
      filter += '##';
    }

    if (this.isScriptInject()) {
      filter += '+js(';
      filter += this.selector;
      filter += ')';
    } else if (this.isScriptBlock()) {
      filter += 'script:contains(';
      filter += this.selector;
      filter += ')';
    } else {
      filter += this.selector;
    }

    return filter;
  }

  public hasHostnameConstraint(): boolean {
    return (
      this.hostnames !== undefined ||
      this.entities !== undefined ||
      this.notEntities !== undefined ||
      this.notHostnames !== undefined
    );
  }

  public match(hostname: string, domain: string): boolean {
    // No `hostname` available but this filter has some constraints on hostname.
    if (
      !hostname &&
      (this.hostnames !== undefined ||
        this.entities !== undefined ||
        this.notHostnames !== undefined ||
        this.notEntities !== undefined)
    ) {
      return false;
    }

    const entitiesHashes: number[] =
      this.entities !== undefined || this.notEntities !== undefined
        ? getEntityHashesFromLabelsBackward(hostname, domain)
        : [];
    const hostnameHashes: number[] =
      this.hostnames !== undefined || this.notHostnames !== undefined
        ? getHostnameHashesFromLabelsBackward(hostname, domain)
        : [];

    // Check if `hostname` is blacklisted
    if (this.notHostnames !== undefined) {
      for (let i = 0; i < hostnameHashes.length; i += 1) {
        if (binLookup(this.notHostnames, hostnameHashes[i])) {
          return false;
        }
      }
    }

    // Check if `hostname` is blacklisted by *entity*
    if (this.notEntities !== undefined) {
      for (let i = 0; i < entitiesHashes.length; i += 1) {
        if (binLookup(this.notEntities, entitiesHashes[i])) {
          return false;
        }
      }
    }

    // Check if `hostname` is allowed
    if (this.hostnames !== undefined || this.entities !== undefined) {
      if (this.hostnames !== undefined) {
        for (let i = 0; i < hostnameHashes.length; i += 1) {
          if (binLookup(this.hostnames, hostnameHashes[i])) {
            return true;
          }
        }
      }

      if (this.entities !== undefined) {
        for (let i = 0; i < entitiesHashes.length; i += 1) {
          if (binLookup(this.entities, entitiesHashes[i])) {
            return true;
          }
        }
      }

      return false;
    }

    return true;
  }

  /**
   * Get tokens for this filter. It can be indexed multiple times if multiple
   * hostnames are specified (e.g.: host1,host2##.selector).
   */
  public getTokens(): Uint32Array[] {
    const tokens: Uint32Array[] = [];

    // Note, we do not need to use negated domains or entities as tokens here
    // since they will by definition not match on their own, unless accompanied
    // by a domain or entity.

    if (this.hostnames !== undefined) {
      for (let i = 0; i < this.hostnames.length; i += 1) {
        tokens.push(new Uint32Array([this.hostnames[i]]));
      }
    }

    if (this.entities !== undefined) {
      for (let i = 0; i < this.entities.length; i += 1) {
        tokens.push(new Uint32Array([this.entities[i]]));
      }
    }

    return tokens;
  }

  public getScript(js: Map<string, string>): string | undefined {
    let scriptName = this.getSelector();
    let scriptArguments: string[] = [];
    if (scriptName.indexOf(',') !== -1) {
      const parts = scriptName.split(',');
      scriptName = parts[0];
      scriptArguments = parts.slice(1).map((s) => s.trim());
    }

    let script = js.get(scriptName);
    if (script !== undefined) {
      for (let i = 0; i < scriptArguments.length; i += 1) {
        script = script.replace(`{{${i + 1}}}`, scriptArguments[i]);
      }

      return script;
    } // TODO - else throw an exception?

    return undefined;
  }

  public getId(): number {
    if (this.id === undefined) {
      this.id = computeFilterId(
        this.mask,
        this.selector,
        this.hostnames,
        this.entities,
        this.notHostnames,
        this.notEntities,
      );
    }
    return this.id;
  }

  public getStyle(): string {
    return this.style || DEFAULT_HIDDING_STYLE;
  }

  public getSelector(): string {
    return this.selector;
  }

  public isUnhide(): boolean {
    return getBit(this.mask, COSMETICS_MASK.unhide);
  }

  public isScriptInject(): boolean {
    return getBit(this.mask, COSMETICS_MASK.scriptInject);
  }

  public isScriptBlock(): boolean {
    return getBit(this.mask, COSMETICS_MASK.scriptBlock);
  }
}
