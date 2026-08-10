"""Hard budget cap: detaches billing from the project when the budget
notification reports spend at or over the budget amount. Deployed by
scripts/deploy_billing_cap.sh; wired budget -> Pub/Sub -> this function.
"""
import base64
import json
import os

import functions_framework
from google.cloud import billing_v1


@functions_framework.cloud_event
def cap(event):
    data = json.loads(base64.b64decode(event.data["message"]["data"]))
    cost, budget = data.get("costAmount", 0), data.get("budgetAmount", 0)
    name = f"projects/{os.environ['CAP_PROJECT']}"
    if not budget or cost < budget:
        print(f"under budget: {cost} of {budget}")
        return
    client = billing_v1.CloudBillingClient()
    if client.get_project_billing_info(name=name).billing_enabled:
        client.update_project_billing_info(
            name=name, project_billing_info=billing_v1.ProjectBillingInfo(
                billing_account_name=""))
        print(f"cap hit at {cost} of {budget}: billing detached from {name}")
