"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner"; // Make sure you have sonner installed
import { MobileLayout } from "@/components/layout/MobileLayout";
import { useAuth } from "@/hooks/use-auth";
import { useOrderStore } from "@/stores/useOrderStore";
import { StarRating } from "@/components/ui/star-rating";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FirebaseProductService } from "@/lib/firebase-products";
import {
  Clock,
  Package,
  Truck,
  CheckCircle,
  XCircle,
  ArrowRight,
  ClipboardList,
  ShoppingBag,
  RefreshCw,
  Loader2,
} from "lucide-react";
import type { Order, Product } from "@/types";
import { OrderTrackingModal } from "../ui/order-tracking-modal";

export default function Orders() {
  const { user } = useAuth();
  const [selectedOrderId, setSelectedOrderId] = useState<string>();
  const [isTrackingOpen, setIsTrackingOpen] = useState(false);
  const [productRatingLoading, setProductRatingLoading] = useState<{
    orderID: string,
    productId: string
  }>({ orderID: "", productId: "" });
  const [userRatings, setUserRatings] = useState<Record<string, number>>({});
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const {
    orders,
    loading,
    loadingMore,
    refreshing,
    hasMore,
    totalOrders,
    error,
    fetchUserOrders,
    loadMoreOrders,
    refreshOrders,
    refreshSingleOrder,
    clearError,
  } = useOrderStore();

  // Get all unique product IDs from all orders
  // const allProductIds = Array.from(
  //   new Set(
  //     orders.flatMap((order) => order.items.map((item) => item.productId))
  //   )
  // );

  const allOrderItems = orders.flatMap((order) =>
    order.items.map((item) => ({
      productId: item.productId,
      orderNumber: order.orderNumber,
    }))
  );
  // Fetch all products using React Query
  const { data: products = [], isLoading: productsLoading } = useQuery<
    Product[]
  >({
    queryKey: ["orders-products", allOrderItems],
    queryFn: async (): Promise<Product[]> => {
      if (allOrderItems.length === 0) return [];

      const productPromises = allOrderItems.map(({ productId }) =>
        FirebaseProductService.getProductById(productId)
      );

      const products = await Promise.all(productPromises);
      return products.filter((product): product is Product => product !== null);
    },
    enabled: allOrderItems.length > 0,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // Create a map for quick product lookups
  const productMap = new Map(products.map((product) => [product.id, product]));

  // Load user ratings for delivered orders
  useEffect(() => {
    const loadUserRatings = async () => {
      if (!user?.uid || !allOrderItems.length) return;

      try {
        const ratingPromises = allOrderItems.map(async ({ productId, orderNumber }) => {
          const rating = await FirebaseProductService.getUserProductRating(
            user.uid,
            productId,
            orderNumber
          );
          return { productId, orderNumber, rating };
        });

        const ratings = await Promise.all(ratingPromises);
        const ratingsMap: Record<string, number> = {};

        ratings.forEach(({ productId, rating, orderNumber }) => {
          if (rating !== null) {
            const key = `${productId}_${orderNumber}`;
            ratingsMap[key] = rating;
          }
        });


        setUserRatings(ratingsMap);
      } catch (error) {
        console.error("Error loading user ratings:", error);
      }
    };

    loadUserRatings();
  }, [user?.uid, allOrderItems]);

  // Initial fetch
  useEffect(() => {
    if (user?.uid && orders.length === 0 && !loading) {
      fetchUserOrders(user.uid);
    }
  }, [user?.uid, fetchUserOrders, orders.length, loading]);

  // Infinite scroll implementation
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const target = entries[0];
        if (
          target.isIntersecting &&
          hasMore &&
          !loadingMore &&
          !loading &&
          user?.uid
        ) {
          loadMoreOrders(user.uid);
        }
      },
      {
        root: null,
        rootMargin: "100px",
        threshold: 0.1,
      }
    );

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current);
    }

    return () => {
      if (loadMoreRef.current) {
        observer.unobserve(loadMoreRef.current);
      }
    };
  }, [hasMore, loadingMore, loading, user?.uid, loadMoreOrders]);

  // Pull to refresh
  const handleRefresh = useCallback(async () => {
    if (user?.uid) {
      await refreshOrders(user.uid);
    }
  }, [user?.uid, refreshOrders]);

  // Handle single order refresh
  const handleSingleOrderRefresh = useCallback(
    async (orderId: string) => {
      await refreshSingleOrder(orderId);
    },
    [refreshSingleOrder]
  );

  // Handle product rating with proper event handling and toast
  const handleProductRating = async (
    productId: string,
    rating: number,
    event: React.MouseEvent,
    productName: string,
    orderNumber: string
  ) => {
    console.log(`Rating product ${productName} with ${rating} stars`);

    // Stop event propagation to prevent opening the modal
    event.stopPropagation();
    event.preventDefault();

    if (!user?.uid) {
      toast.error("Please login to rate products");
      return;
    }

    // Check if user already rated this product
    const ratingKey = `${productId}_${orderNumber}`;
    if (userRatings[ratingKey]) {
      toast.info(
        `You already rated "${productName}" with ${userRatings[ratingKey]} stars`
      );
      return;
    }

    setProductRatingLoading({
      productId: productId,
      orderID: orderNumber
    });

    try {
      // Show optimistic UI update
      setUserRatings((prev) => ({ ...prev, [ratingKey]: rating }));

      await FirebaseProductService.updateProductRating(
        productId,
        rating,
        user.uid,
        orderNumber
      );

      // Show success toast
      toast.success(
        `Thanks for rating "${productName}" with ${rating} star${rating !== 1 ? "s" : ""
        }!`,
        {
          duration: 3000,
        }
      );

      // Invalidate and refetch the products query to update ratings
      await queryClient.invalidateQueries({
        queryKey: ["orders-products", allOrderItems],
      });
    } catch (error) {
      console.error("Error rating product:", error);

      // Revert optimistic update
      setUserRatings((prev) => {
        const newRatings = { ...prev };
        delete newRatings[ratingKey];
        return newRatings;
      });

      toast.error(`Failed to rate "${productName}". Please try again.`);
    } finally {
      setProductRatingLoading({ orderID: "", productId: "" });
    }
  };

  /** Status Icons */
  const getStatusIcon = (status: Order["status"]) => {
    switch (status) {
      case "delivered":
        return <CheckCircle className="text-success" size={20} />;
      case "out_for_delivery":
        return <Truck className="text-info" size={20} />;
      case "preparing":
        return <Package className="text-warning" size={20} />;
      case "confirmed":
        return <Clock className="text-info" size={20} />;
      case "cancelled":
        return <XCircle className="text-destructive" size={20} />;
      case "refunded":
        return <XCircle className="text-muted-foreground" size={20} />;
      default:
        return <Clock className="text-muted-foreground" size={20} />;
    }
  };

  /** Status Badge Variants */
  const getStatusVariant = (status: Order["status"]) => {
    switch (status) {
      case "delivered":
        return "default" as const;
      case "out_for_delivery":
        return "secondary" as const;
      case "preparing":
        return "outline" as const;
      case "confirmed":
        return "secondary" as const;
      case "cancelled":
      case "refunded":
        return "destructive" as const;
      default:
        return "outline" as const;
    }
  };

  /** Status Text */
  const getStatusText = (status: Order["status"]) => {
    switch (status) {
      case "delivered":
        return "Delivered";
      case "out_for_delivery":
        return "Out for Delivery";
      case "preparing":
        return "Preparing";
      case "confirmed":
        return "Confirmed";
      case "cancelled":
        return "Cancelled";
      case "placed":
        return "Order Placed";
      case "refunded":
        return "Refunded";
      default:
        return status;
    }
  };

  /** Handle Order Card Click */
  const handleOrderClick = (orderId: string) => {
    setSelectedOrderId(orderId);
    setIsTrackingOpen(true);
  };

  /** Handle Track Order Button Click */
  const handleTrackOrderClick = (e: React.MouseEvent, orderId: string) => {
    e.stopPropagation(); // Prevent card click
    handleOrderClick(orderId);
  };

  /** Date Formatter */
  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  /** Format Currency */
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
      .format(amount)
      .replace("₹", "");
  };

  // Loading Skeleton Component
  const OrderSkeleton = () => (
    <Card className="mobile-card-hover">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="w-24 h-4 bg-muted animate-pulse rounded"></div>
          <div className="w-20 h-6 bg-muted animate-pulse rounded-full"></div>
        </div>
        <div className="space-y-2 mb-3">
          <div className="flex items-center space-x-3 p-2 bg-muted/30 rounded-lg">
            <div className="w-10 h-10 bg-muted animate-pulse rounded-md"></div>
            <div className="flex-1">
              <div className="w-full h-4 bg-muted animate-pulse rounded mb-2"></div>
              <div className="w-3/4 h-3 bg-muted animate-pulse rounded"></div>
            </div>
          </div>
        </div>
        <div className="flex justify-between items-center mb-2">
          <div className="w-32 h-4 bg-muted animate-pulse rounded"></div>
        </div>
        <div className="w-full h-4 bg-muted animate-pulse rounded mb-3"></div>
        <div className="flex border-2 p-2 rounded-lg items-center justify-between">
          <div className="w-24 h-4 bg-muted animate-pulse rounded"></div>
          <div className="w-4 h-4 bg-muted animate-pulse rounded"></div>
        </div>
      </CardContent>
    </Card>
  );

  // Error component
  const ErrorComponent = () => (
    <div className="flex-1 flex items-center justify-center p-4 min-h-[400px]">
      <div className="text-center">
        <div className="w-20 h-20 bg-destructive/10 rounded-full flex items-center justify-center mx-auto mb-6">
          <XCircle className="text-destructive" size={40} />
        </div>
        <h3 className="font-semibold text-lg mb-2">Something went wrong</h3>
        <p className="text-muted-foreground mb-6 max-w-sm">
          {error || "Failed to load orders. Please try again."}
        </p>
        <div className="flex gap-3 justify-center">
          <Button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-6"
          >
            {refreshing ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            Try Again
          </Button>
          <Button variant="outline" onClick={clearError} className="px-6">
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );

  // Empty state component
  const EmptyState = () => (
    <div className="flex-1 flex items-center justify-center p-4 min-h-[400px]">
      <div className="text-center">
        <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-6">
          <ClipboardList className="text-muted-foreground" size={40} />
        </div>
        <h3 className="font-semibold text-lg mb-2">No orders yet</h3>
        <p className="text-muted-foreground mb-6 max-w-sm">
          Start shopping to see your orders here. Your order history will appear
          once you make your first purchase.
        </p>
        <Button
          onClick={() => (window.location.href = "/")}
          className="px-8 py-2"
          data-testid="start-shopping-button"
        >
          <ShoppingBag className="w-4 h-4 mr-2" />
          Start Shopping
        </Button>
      </div>
    </div>
  );

  return (
    <MobileLayout
      title="Your Orders"
      subtitle={
        totalOrders > 0
          ? `${totalOrders} orders`
          : "Track and manage your orders"
      }
      currentPage="orders"
      showBackButton={false}
    >
      {/* Header with refresh button */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center space-x-2">
          <h2 className="font-semibold">Recent Orders</h2>
          {totalOrders > 0 && (
            <Badge variant="secondary" className="text-xs">
              {totalOrders}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          className="h-8 w-8"
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {error && !loading ? (
          <ErrorComponent />
        ) : loading && orders.length === 0 ? (
          <div className="space-y-4 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <OrderSkeleton key={i} />
            ))}
          </div>
        ) : orders.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-4 p-4">
            {orders.map((order) => {
              const itemCount = order.items.length;
              const verificationStatus =
                order.paymentDetails?.verificationStatus || "pending";

              return (
                <Card
                  key={order.id}
                  className="mobile-card-hover transition-all duration-200 hover:shadow-md"
                  data-testid={`order-card-${order.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center space-x-3">
                        {getStatusIcon(order.status)}
                        <div>
                          <p className="font-semibold text-xs">
                            #{order.orderNumber}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(order.createdAt)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Badge
                          variant={getStatusVariant(order.status)}
                          className="text-xs"
                        >
                          {getStatusText(order.status)}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSingleOrderRefresh(order.id);
                          }}
                        >
                          <RefreshCw className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>

                    {/* Order Items Preview - Show ALL items */}
                    <div className="space-y-2 mb-3">
                      {order.items.map((item, itemIndex) => {
                        const product = productMap.get(item.productId);
                        const canRate = order.status === "delivered";
                        const ratingKey = `${item.productId}_${order.orderNumber}`;
                        const userRating = userRatings[ratingKey];

                        // const userRating = userRatings[item.productId];
                        const currentRating =
                          userRating || product?.averageRating || 0;

                        return (
                          <div
                            key={itemIndex}
                            className="flex items-center space-x-3 p-2 bg-muted/30 rounded-lg"
                          >
                            {item.imageUrl && (
                              <img
                                src={item.imageUrl}
                                alt={item.productName}
                                className="w-10 h-10 rounded-md object-cover"
                                loading="lazy"
                              />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">
                                {item.productName}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Qty: {item.quantity} × ₹
                                {formatCurrency(item.price)}
                              </p>

                              {/* Product Rating Section - Only show for delivered orders */}
                              {product && order.status === "delivered" && (
                                <div
                                  className="mt-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <StarRating
                                    rating={userRating || 0}
                                    readonly={!!userRating}
                                    disabled={
                                      productRatingLoading.productId === item.productId && order.orderNumber === productRatingLoading.orderID
                                    }
                                    size="sm"
                                    showCount={false}
                                    onRatingChange={
                                      !userRating
                                        ? (rating, event) =>
                                          handleProductRating(
                                            item.productId,
                                            rating,
                                            event,
                                            item.productName,
                                            order.orderNumber
                                          )
                                        : undefined
                                    }
                                  />
                                  {productRatingLoading.productId === item.productId && order.orderNumber === productRatingLoading.orderID && (
                                    <div className="flex items-center mt-1">
                                      <Loader2 className="w-3 h-3 animate-spin mr-1" />
                                      <span className="text-xs text-muted-foreground">
                                        Saving rating...
                                      </span>
                                    </div>
                                  )}
                                  {userRating ? (
                                    <div className="text-xs text-success mt-1">
                                      ✓ You rated: {userRating} star
                                      {userRating !== 1 ? "s" : ""}
                                    </div>
                                  ) : (
                                    <div className="text-xs text-muted-foreground mt-1">
                                      Tap stars to rate this product
                                    </div>
                                  )}
                                </div>
                              )}
                              {productsLoading && !product && (
                                <div className="w-20 h-3 bg-muted animate-pulse rounded mt-1" />
                              )}
                            </div>
                            <span className="text-sm font-medium">
                              ₹{formatCurrency(item.total)}
                            </span>
                          </div>
                        );
                      })}

                      {/* Order total */}
                      <div className="flex justify-between items-center pt-2 border-t border-muted/50">
                        <span className="text-sm font-medium">
                          Total Amount:
                        </span>
                        <span className="text-sm font-bold">
                          ₹{formatCurrency(order.total)}
                        </span>
                      </div>
                    </div>

                    {/* Payment Status - Using verification status */}
                    <div className="flex items-center justify-between text-xs mb-2">
                      <div className="flex items-center space-x-2">
                        <span className="text-muted-foreground">Payment:</span>
                        <Badge
                          variant={
                            verificationStatus === "verified"
                              ? "default"
                              : verificationStatus === "rejected"
                                ? "destructive"
                                : "outline"
                          }
                          className="text-xs px-2 py-0"
                        >
                          {verificationStatus === "verified"
                            ? "Verified"
                            : verificationStatus === "rejected"
                              ? "Failed"
                              : "Pending"}
                        </Badge>
                        <span className="text-muted-foreground">•</span>
                        <span className="text-muted-foreground capitalize">
                          {order.paymentMethod.replace("_", " ")}
                        </span>
                      </div>
                    </div>

                    {/* Delivery Info */}
                    {order.estimatedDeliveryTime &&
                      order.status !== "delivered" && (
                        <div className="text-xs text-muted-foreground mb-3">
                          <Clock className="w-3 h-3 inline mr-1" />
                          Estimated delivery:{" "}
                          {formatDate(order.estimatedDeliveryTime)}
                        </div>
                      )}

                    {/* Track Order Button */}
                    <div
                      className="flex border-2 p-2 rounded-lg items-center justify-between cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={(e) => handleTrackOrderClick(e, order.id)}
                    >
                      <div className="text-sm">
                        {order.status === "delivered" ? (
                          <span className="text-success font-medium flex items-center">
                            <CheckCircle className="w-4 h-4 mr-1" />
                            Order Delivered
                          </span>
                        ) : order.status === "cancelled" ||
                          order.status === "refunded" ? (
                          <span className="text-destructive font-medium flex items-center">
                            <XCircle className="w-4 h-4 mr-1" />
                            {getStatusText(order.status)}
                          </span>
                        ) : (
                          <span className="text-primary font-medium flex items-center">
                            <Package className="w-4 h-4 mr-1" />
                            Track Order
                          </span>
                        )}
                      </div>
                      <ArrowRight size={16} className="text-muted-foreground" />
                    </div>
                  </CardContent>
                </Card>
              );
            })}

            {/* Load More Trigger */}
            {hasMore && (
              <div
                ref={loadMoreRef}
                className="flex items-center justify-center py-8"
              >
                {loadingMore ? (
                  <div className="flex items-center space-x-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm">Loading more orders...</span>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    Scroll to load more orders
                  </div>
                )}
              </div>
            )}

            {/* End of results indicator */}
            {!hasMore && orders.length > 0 && (
              <div className="text-center py-8">
                <div className="text-sm text-muted-foreground">
                  🎉 You've reached the end!
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  No more orders to show
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Order Tracking Modal */}
      <OrderTrackingModal
        isOpen={isTrackingOpen}
        onClose={() => setIsTrackingOpen(false)}
        orderId={selectedOrderId}
        orders={orders}
        onRefresh={handleSingleOrderRefresh}
      />
    </MobileLayout>
  );
}
