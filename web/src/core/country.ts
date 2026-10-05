// The rules of the road that differ from country to country, as the game uses them: which side traffic keeps to, when
// you may use your hazard lights, and whether a space belongs to the first driver to reach it. Sources are in Info.
//
// The UK: hazard lights only while stationary, to warn that you are temporarily obstructing traffic; never while driving
// or to excuse bad parking (Highway Code rule 116). Signalling gives you no priority for a space.
// Germany: the space belongs to the first driver to reach it, even while they pull past to reverse in or wait for a car
// to leave (StVO §12(5)); hazard lights only for danger (StVO §16).
// Morocco: traffic keeps right, under the Code de la route (loi n° 52-05, in force since 1 October 2010). Its rules on
// hazard lights and on who gets a space are not checked yet, so the game does not score them there.
import type { Drive } from './city';

export type CountryId = 'ma' | 'de' | 'gb';
export interface Country {
  id: CountryId; name: string;
  drive: Drive;
  /** When hazard lights may be on: only while you are stopped ('stationary'), only for danger ('danger'), or not checked. */
  hazards: 'stationary' | 'danger' | null;
  /** Whether a space belongs to whoever reached it first (a thief breaks the law), or not (it is only rude), or not checked. */
  firstReached: boolean | null;
  /** The rules the game follows there, for Info and the messages. */
  law: string;
}
export const COUNTRIES: Record<CountryId, Country> = {
  ma: { id: 'ma', name: 'Morocco', drive: 'right', hazards: null, firstReached: null, law: 'Code de la route (loi n° 52-05)' },
  de: { id: 'de', name: 'Germany', drive: 'right', hazards: 'danger', firstReached: true, law: 'StVO §12(5) and §16' },
  gb: { id: 'gb', name: 'the UK', drive: 'left', hazards: 'stationary', firstReached: false, law: 'Highway Code rule 116' },
};
/** The country for settings saved before there was a choice of country: driving on the left was the UK's. */
export const countryOf = (stored: { country?: string; drive?: string }): CountryId =>
  stored.country === 'ma' || stored.country === 'de' || stored.country === 'gb' ? stored.country : stored.drive === 'left' ? 'gb' : 'ma';
/** What it means that a thief took the space you were after, by the country's rules. */
export function theftNote(c: Country): string {
  return c.firstReached === true ? 'In Germany the space was yours: you reached it first, so the thief broke the law (StVO §12(5)).'
    : c.firstReached === false ? 'In the UK signalling gives you no right to a space: the thief was only rude.'
    : `Whose space it was under ${c.name}'s rules is not in the game yet.`;
}
