variable "aws_profile" {
  description = "Local AWS CLI Profile"
  type        = string
  default     = "depi-admin" # غيره لـ terraform_dev لو ده الاسم اللي عندك
}

variable "aws_region" {
  description = "AWS Region"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project prefix for resource naming"
  type        = string
  default     = "depi-nexus"
}

variable "vpc_cidr" {
  description = "VPC CIDR Block"
  type        = string
  default     = "10.0.0.0/16"
}

variable "azs" {
  description = "2 Availability Zones"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "public_subnets" {
  description = "Public Subnets CIDRs (ALB, NAT, Bastion)"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnets" {
  description = "Private Subnets CIDRs (K8s Cluster, In-Cluster MongoDB & Observability)"
  type        = list(string)
  default     = ["10.0.10.0/24", "10.0.11.0/24"]
}

variable "bastion_instance_type" {
  description = "Bastion + Ansible Controller instance type (1 vCPU)"
  type        = string
  default     = "t2.micro" # ممكن ترفعها لـ t2.small لو حبيت 2GB RAM ولسه 1 vCPU
}

variable "k8s_instance_type" {
  description = "K8s Master & Worker instance type (2 vCPUs each)"
  type        = string
  default     = "t3.medium" # ممكن ترفعها لـ t3.large وقت الديمو بنفس الـ 2 vCPU و 8GB RAM
}

variable "gateway_http_nodeport" {
  description = "NodePort that Kubernetes Gateway API HTTP Listener will expose"
  type        = number
  default     = 30080
}

variable "enable_nat_gateway" {
  description = "Toggle NAT Gateway and its EIP on/off to save cost when EC2s are stopped"
  type        = bool
  default     = true
}