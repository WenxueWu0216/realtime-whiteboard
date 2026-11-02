variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "whiteboard"
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "azs_count" {
  description = "Availability zones to span (EKS needs >= 2)."
  type        = number
  default     = 2
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "cluster_version" {
  type    = string
  default = "1.31"
}

variable "node_instance_types" {
  description = "Worker node types. t3.medium = 2 vCPU / 4 GiB: fits ~2 server pods (1 vCPU limit each) plus system pods."
  type        = list(string)
  default     = ["t3.medium"]
}

variable "node_min_size" {
  type    = number
  default = 2
}

variable "node_desired_size" {
  type    = number
  default = 2
}

variable "node_max_size" {
  description = "Upper bound for nodes. The HPA adds pods; add Cluster Autoscaler/Karpenter to add nodes automatically."
  type        = number
  default     = 4
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "recording_ia_after_days" {
  description = "Move recordings (op segments + snapshots) to S3 Standard-IA after N days."
  type        = number
  default     = 30
}

variable "recording_expire_after_days" {
  description = "Delete recordings after N days (0 = keep forever)."
  type        = number
  default     = 365
}

variable "allowed_origins" {
  description = "Browser origins allowed to GET presigned recording URLs (S3 CORS). Narrow this to your app's URL."
  type        = list(string)
  default     = ["*"]
}

variable "k8s_namespace" {
  type    = string
  default = "whiteboard"
}

variable "helm_release" {
  description = "Helm release name; the server ServiceAccount is <release>-whiteboard."
  type        = string
  default     = "wb"
}

variable "github_repo" {
  description = "owner/repo allowed to push images to ECR via GitHub Actions OIDC. Empty = don't create the CI role."
  type        = string
  default     = "WenxueWu0216/realtime-whiteboard"
}

variable "create_github_oidc_provider" {
  description = "Set false if the account already has the token.actions.githubusercontent.com OIDC provider."
  type        = bool
  default     = true
}
