output "region" {
  value = var.region
}

output "cluster_name" {
  value = module.eks.cluster_name
}

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}

output "ecr_server" {
  value = aws_ecr_repository.this["server"].repository_url
}

output "ecr_client" {
  value = aws_ecr_repository.this["client"].repository_url
}

output "ecr_registry" {
  value = split("/", aws_ecr_repository.this["server"].repository_url)[0]
}

output "redis_url" {
  description = "TLS endpoint of the ElastiCache primary."
  value       = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
}

output "recordings_bucket" {
  value = aws_s3_bucket.recordings.bucket
}

output "server_irsa_role_arn" {
  value = module.server_irsa.iam_role_arn
}

output "lb_controller_role_arn" {
  value = module.lb_controller_irsa.iam_role_arn
}

output "vpc_id" {
  value = module.vpc.vpc_id
}

output "ci_role_arn" {
  value = try(aws_iam_role.ci[0].arn, "")
}

# Everything environment-specific the Helm chart needs, ready to save as a
# values file: terraform output -raw helm_values > ../../deploy/helm/whiteboard/values-eks.generated.yaml
output "helm_values" {
  value = <<-YAML
    server:
      image:
        repository: ${aws_ecr_repository.this["server"].repository_url}
    client:
      image:
        repository: ${aws_ecr_repository.this["client"].repository_url}
    serviceAccount:
      annotations:
        eks.amazonaws.com/role-arn: ${module.server_irsa.iam_role_arn}
    redis:
      url: rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379
    s3:
      bucket: ${aws_s3_bucket.recordings.bucket}
      region: ${var.region}
  YAML
}
