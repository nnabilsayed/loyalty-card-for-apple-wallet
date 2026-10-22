import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

/** `+201001234567` becomes `+20 100 *** 4567`: enough for staff to recognise a customer, not to copy the number. */
export function maskPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return "***";
  const national = parsed.nationalNumber;
  if (national.length < 8) return `+${parsed.countryCallingCode} ***`;
  return `+${parsed.countryCallingCode} ${national.slice(0, 3)} *** ${national.slice(-4)}`;
}

/**
 * Turns whatever a customer typed into one canonical form (E.164, e.g. `+201001234567`), or null
 * if it is not a valid phone number. A number without a country code is read as `region`'s.
 */
export function normalizePhone(input: string, region: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const parsed = parsePhoneNumberFromString(text, region as CountryCode);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}
