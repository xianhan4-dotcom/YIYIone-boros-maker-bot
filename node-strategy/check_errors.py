import json
from pathlib import Path

path = (
    Path(__file__).resolve().parent
    / "node_modules"
    / "@pendle"
    / "boros-core"
    / "artifacts"
    / "contracts"
    / "offchain-helpers"
    / "errors"
    / "SDKErrorsDirectory.sol"
    / "SDKErrorsDirectory.json"
)
with path.open(encoding="utf-8") as f:
    data = json.load(f)

for item in data.get('abi', []):
    if item.get('type') == 'error':
        name = item.get('name', '')
        inputs = item.get('inputs', [])
        # Print all errors for review
        print(f'{name}: {json.dumps(inputs)}')
