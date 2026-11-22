import { allianceGroups } from "./states";
import type { ElectionType, StateCode } from "./states";

/**
 * Plain-language caveats that apply when two elections of the same state and type are compared (swing, trend).
 * Every note is a fact about the data, not an interpretation of the result.
 */
export function comparabilityNotes(state: StateCode, from: number, to: number, type: ElectionType): string[] {
  const lo = Math.min(from, to), hi = Math.max(from, to);
  const notes: string[] = [];

  if (lo <= 2014 && hi >= 2014) {
    notes.push(state === "AP"
      ? "2014 was the first election after the 2 June 2014 bifurcation: Andhra Pradesh is the residual state (175 assembly, 25 Lok Sabha seats). Results from before 2014 refer to undivided Andhra Pradesh and are not in this dataset."
      : "2014 was the first election after the 2 June 2014 bifurcation that created Telangana (119 assembly, 17 Lok Sabha seats). Results from before 2014 refer to undivided Andhra Pradesh and are not in this dataset.");
  }
  if (type === "assembly" && lo <= 2014 && hi >= 2014) {
    notes.push("The 2014 assembly elections in Andhra Pradesh and Telangana were held together with the Lok Sabha polls (April and May 2014), so assembly and Lok Sabha vote shares for 2014 reflect the same electorate and campaign.");
  }
  notes.push(`Constituency boundaries follow the 2008 delimitation throughout (${state === "AP" ? "175 assembly / 25 Lok Sabha" : "119 assembly / 17 Lok Sabha"} seats), so seat-level comparisons are like for like.`);

  const districtChange = state === "AP" ? lo < 2022 : lo < 2019;
  if (districtChange) {
    notes.push(state === "AP"
      ? "District boundaries changed after these elections (13 districts to 26 in April 2022; later additions are reflected in the current LGD list). District-level figures before 2022 use the old districts; use the district crosswalk, not names, to compare."
      : "District boundaries changed after these elections (10 districts to 31 in 2016 and 33 in 2019). District-level figures before 2019 use the old districts; use the district crosswalk, not names, to compare.");
  }
  if (state === "TG" && lo <= 2022 && hi >= 2023) {
    notes.push("Telangana Rashtra Samithi (TRS) was renamed Bharat Rashtra Samithi (BRS) in 2022; earlier TRS results are shown under the code BRS.");
  }

  const a = allianceGroups(state, from, type, "pre-poll"), b = allianceGroups(state, to, type, "pre-poll");
  const sig = (g: typeof a) => g.map(x => x.parties.join("+")).sort().join("|");
  if ((a.length || b.length) && sig(a) !== sig(b)) {
    notes.push("Pre-poll alliance arrangements differ between the two elections; party vote shares are shown per party, so a party's swing can reflect an alliance change rather than a change in support.");
  }
  notes.push("A party that did not contest one of the elections counts as 0% in that election.");
  return notes;
}
