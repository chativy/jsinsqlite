import {
  DEFAULT_PORT,
  dataDirOf,
  firstPort,
  isPiName,
} from "./pi.sqlite?module=pi";

console.log({
  defaultPort: DEFAULT_PORT,
  namedPort: firstPort(dataDirOf({ pi: "work" })),
  validName: isPiName("work"),
});
