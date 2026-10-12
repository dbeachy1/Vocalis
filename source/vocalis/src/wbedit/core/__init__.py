"""Pure logic: the output contract, the validators, the locator walk.

🔴 NO I/O IN THIS PACKAGE. No file access, no network, no logging, no clock, no config lookup.
Everything arrives as an argument. It is the part most worth unit-testing and the most dangerous
place for a side effect, and keeping it pure is what lets the validator suite be exhaustive
without a fixture tree.
"""
