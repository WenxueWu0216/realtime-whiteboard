# Deploying to AWS (EKS + ElastiCache + S3)

This guide stands up the whiteboard on AWS. **Everything here creates paid
resources in your account**; the [cost estimate](#estimated-cost) and the
[teardown](#teardown) are at the end. Nothing in this repo creates AWS
resources on its own.

```
                     ┌──────────────── VPC (2 AZs) ───────────────────────────┐
 browser ── HTTP/WS ─┼─▶ ALB (AWS LB Controller, idle timeout 3600 s)         │
    │                │     ├─ /ws, /boards ─▶ server pods (Deployment + HPA)  │
    │                │     └─ /            ─▶ client pods (nginx)              │
    │                │   server pods ─▶ ElastiCache Redis (TLS) pub/sub+Streams│
    │                │   server pods ─▶ MongoDB StatefulSet (gp3 EBS)          │
    │                │   server pods ─IRSA─▶ S3 recordings bucket (private)    │
    └── presigned GET ───────────────────────────────▶ S3                      │
                     └──────────────────────────────────────────────────────────┘
 GitHub Actions ─OIDC─▶ ECR (server, client images)
```

What Terraform (`infra/terraform`) creates:

| Resource | Details |
|---|---|
| VPC | 2 AZs, private subnets for nodes/Redis, public subnets for the ALB, **one** NAT gateway (cost; use one per AZ for HA) |
| EKS | Kubernetes 1.31, managed node group of 2× `t3.medium` (min 2 / max 4), add-ons: CoreDNS, kube-proxy, VPC CNI, **metrics-server** (for the HPA), EBS CSI driver |
| ElastiCache | Redis 7.1, `cache.t4g.micro`, encryption at rest + in transit (`rediss://`), reachable only from the node security group |
| S3 | private recordings bucket: public access blocked, bucket-owner-enforced, SSE-S3, TLS-only policy, CORS for presigned GETs, **lifecycle**: `boards/` → Standard-IA after 30 days, expire after 365 days, abort incomplete uploads after 7 days |
| IAM (IRSA) | server pods get **S3 Get/Put on `boards/*` only**, via their ServiceAccount; roles for the AWS Load Balancer Controller and EBS CSI driver. No static AWS keys |
| ECR | `whiteboard/server`, `whiteboard/client`: immutable tags, scan on push, keep last 20 |
| GitHub OIDC | optional role that lets this repo's Actions push to ECR on tags / `main` |

**MongoDB choice.** Mongo only holds small metadata (live-doc snapshots and the recording index); recordings live in S3. For this demo it runs as a single-replica StatefulSet on a gp3 volume (`deploy/k8s-aws/mongo.yaml`), which adds no managed-service cost. For production use **MongoDB Atlas** (or a 3-member replica set): you get backups, failover and no EBS volume to babysit. Only the `whiteboard-mongo` secret changes. Amazon DocumentDB is another option, but its minimum instance costs more than this whole demo.

## Prerequisites

- An AWS account and credentials for an IAM user/role that can create the resources above (`aws sts get-caller-identity` works)
- `terraform` ≥ 1.6, `aws` CLI v2, `kubectl`, `helm` ≥ 3.14, `docker`
- A region (default `us-east-1`)

## 1. Infrastructure

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # edit region / sizes if you like
terraform init
terraform fmt -recursive
terraform plan -out tf.plan                      # review: ~60 resources
terraform apply tf.plan                          # ~15-20 min (EKS + ElastiCache)
```

Save the outputs you'll need:

```bash
eval "$(terraform output -raw kubeconfig_command)"
export REGION=$(terraform output -raw region)
export REGISTRY=$(terraform output -raw ecr_registry)
export LBC_ROLE=$(terraform output -raw lb_controller_role_arn)
export VPC_ID=$(terraform output -raw vpc_id)
export CLUSTER=$(terraform output -raw cluster_name)
terraform output -raw helm_values > ../../deploy/helm/whiteboard/values-eks.generated.yaml
cd ../..
kubectl get nodes   # 2 nodes Ready
```

### Remote state (optional)

State is local by default. For a team, create an S3 bucket + DynamoDB lock table once, uncomment the `backend "s3"` block in `versions.tf`, and run `terraform init -migrate-state`.

## 2. Build and push images

```bash
export TAG=$(git rev-parse --short HEAD)
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REGISTRY
docker build -t $REGISTRY/whiteboard/server:$TAG server
docker build -t $REGISTRY/whiteboard/client:$TAG client   # no VITE_* args: same-origin /ws and API
docker push $REGISTRY/whiteboard/server:$TAG
docker push $REGISTRY/whiteboard/client:$TAG
```

Build on an x86_64 machine, or add `--platform linux/amd64` (nodes are `t3`). Or use the `images` GitHub workflow: set repository variables `AWS_REGION`, `AWS_CI_ROLE_ARN` (`terraform output ci_role_arn`) and `ECR_REGISTRY`, then push a `v*` tag.

## 3. AWS Load Balancer Controller

```bash
helm repo add eks https://aws.github.io/eks-charts && helm repo update
helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller -n kube-system \
  --set clusterName=$CLUSTER --set region=$REGION --set vpcId=$VPC_ID \
  --set serviceAccount.create=true --set serviceAccount.name=aws-load-balancer-controller \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=$LBC_ROLE
kubectl -n kube-system rollout status deploy/aws-load-balancer-controller
```

## 4. MongoDB

```bash
kubectl create namespace whiteboard
MONGO_PW=$(openssl rand -hex 16)
kubectl -n whiteboard create secret generic mongo-auth --from-literal=username=whiteboard --from-literal=password=$MONGO_PW
kubectl -n whiteboard create secret generic whiteboard-mongo \
  --from-literal=MONGO_URL="mongodb://whiteboard:$MONGO_PW@mongo-0.mongo.whiteboard.svc:27017/?authSource=admin"
kubectl apply -f deploy/k8s-aws/mongo.yaml
kubectl -n whiteboard rollout status statefulset/mongo
```

(Atlas instead: skip `mongo.yaml` and put the Atlas connection string in `whiteboard-mongo`. Allow the NAT gateway's public IP in Atlas network access.)

## 5. Deploy the app

```bash
helm upgrade --install wb deploy/helm/whiteboard -n whiteboard \
  -f deploy/helm/whiteboard/values-eks.yaml \
  -f deploy/helm/whiteboard/values-eks.generated.yaml \
  --set server.image.tag=$TAG --set client.image.tag=$TAG
kubectl -n whiteboard rollout status deploy/wb-whiteboard-server
export APP=$(kubectl -n whiteboard get ingress wb-whiteboard -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
echo "http://$APP/?room=demo"    # the ALB DNS name takes 2-3 min to resolve
```

The release name must stay `wb` (or change `helm_release` in Terraform): the IRSA role trusts exactly the `whiteboard:wb-whiteboard` ServiceAccount.

## 6. Verify

```bash
# pods ready, HPA reading CPU (TARGETS shows a %, not <unknown>)
kubectl -n whiteboard get pods,hpa
curl -s http://$APP/healthz      # served by one of the server pods

# recording reaches S3 with IRSA credentials (no keys in the pod)
(cd server && npx tsx scripts/seed-session.ts --url ws://$APP/ws --room demo --ops 2000)
aws s3 ls s3://$(cd infra/terraform && terraform output -raw recordings_bucket)/boards/demo/ --recursive | head
curl -s "http://$APP/boards/demo/timeline"
curl -s "http://$APP/boards/demo/replay?at=30000" | head -c 300; echo
```

Open `http://$APP/?room=demo&replay=1`: the debug overlay should show `snapshot used: seq …` and the browser network tab should show GETs to `*.s3.<region>.amazonaws.com` with `X-Amz-Signature`.

**Cross-pod fan-out.** Open the room in two browsers. There are no sticky sessions, so they usually land on different pods (`kubectl -n whiteboard logs -l app.kubernetes.io/component=server`). Edits still sync, through ElastiCache pub/sub.

**HPA scale-out:**

```bash
kubectl -n whiteboard get hpa -w &
(cd server && npx tsx loadtest/conn-ramp.ts --url ws://$APP/ws --http-url none --step 500 --max 3000 --p99-limit 100000)
```

Replicas grow when average CPU passes 40% (the target chosen from the load test). Scale-down waits 5 min by design.

**Graceful shutdown.** `kubectl -n whiteboard delete pod <server-pod>`: clients on it reconnect to another pod within seconds, and `aws s3 ls` shows the pod's last segment flushed before it exited.

## Estimated cost

On-demand `us-east-1` list prices (check the [AWS pricing calculator](https://calculator.aws/) for your region and date):

| Item | Rate | ~Per month (730 h) |
|---|---|---|
| EKS control plane | $0.10/h | $73 |
| 2× t3.medium nodes | 2 × $0.0416/h | $61 |
| NAT gateway | $0.045/h + $0.045/GB | $33 + data |
| Application Load Balancer | $0.0225/h + LCUs | ~$18–25 |
| ElastiCache cache.t4g.micro | $0.016/h | $12 |
| Public IPv4 (NAT + ALB, ~3) | $0.005/h each | $11 |
| EBS: 2× 20 GB node + 10 GB Mongo gp3 | $0.08/GB-mo | $4 |
| S3, ECR, data transfer, CloudWatch | usage | < $5 at demo scale |
| **Total** | **≈ $0.30/h** | **≈ $215–225 / month** |

A few hours of demoing costs about $1–2. Teardown the same day.

Ways to cut cost: use 1 node (`node_min_size = node_desired_size = 1`), Spot nodes, or delete the NAT gateway after images are pulled (nodes then can't reach ECR/the internet).

## Teardown

Delete the Kubernetes objects that own AWS resources **first**. The ALB and the EBS volume were created by controllers, not Terraform, and would block VPC deletion:

```bash
helm -n whiteboard uninstall wb                          # removes the Ingress -> ALB is deleted
kubectl delete -f deploy/k8s-aws/mongo.yaml              # StatefulSet + gp3 StorageClass
kubectl -n whiteboard delete pvc --all                   # deletes the EBS volume
helm -n kube-system uninstall aws-load-balancer-controller
# wait until no load balancer is left for the VPC:
aws elbv2 describe-load-balancers --region $REGION --query "LoadBalancers[?VpcId=='$VPC_ID'].LoadBalancerName"

cd infra/terraform
terraform destroy        # the bucket and ECR repos have force_destroy: recordings and images are deleted
```

Then check that nothing is still billing: EC2 → Load Balancers, EC2 → Volumes (`available` volumes), VPC → NAT gateways and Elastic IPs, and ElastiCache should all be empty for this project. CloudWatch log groups `/aws/eks/whiteboard/*` can be deleted manually; they cost cents.
