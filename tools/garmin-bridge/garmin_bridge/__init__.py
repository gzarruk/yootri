"""A personal, local bridge from Garmin Connect to the yootri planner.

Parts of this package are adapted from GARMIN-CLAUDE
(https://github.com/gzarruk/GARMIN-CLAUDE) by nandocfz, MIT licensed.
"""

__version__ = "0.1.0"

# The shape of /v1/activities. The page refuses any other value, so a bridge
# and a page that disagree about the contract say so instead of mis-reading it.
API_VERSION = 1
